/*! Copyright [Amazon.com](http://amazon.com/), Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0 */
import * as path from "path";
import { DependencyType, IgnoreFile } from "projen";
import { NodePackageManager } from "projen/lib/javascript";
import { TypeScriptProject } from "projen/lib/typescript";
import {
  CodeGenerationSourceOptions,
  GeneratedTypeScriptInfrastructureOptions,
} from "../../../types";
import { OpenApiGeneratorHandlebarsIgnoreFile } from "../../components/open-api-generator-handlebars-ignore-file";
import { OpenApiGeneratorIgnoreFile } from "../../components/open-api-generator-ignore-file";
import { OpenApiToolsJsonFile } from "../../components/open-api-tools-json-file";
import { TypeSafeApiCommandEnvironment } from "../../components/type-safe-api-command-environment";
import {
  buildCleanOpenApiGeneratedCodeCommand,
  buildInvokeMockDataGeneratorCommand,
  buildInvokeOpenApiGeneratorCommandArgs,
  buildTypeSafeApiExecCommand,
  getHandlersProjectVendorExtensions,
  OtherGenerators,
  TypeSafeApiScript,
} from "../../components/utils";
import { GeneratedHandlersProjects } from "../../generate";
import { GeneratedTypescriptRuntimeProject } from "../../runtime/generated-typescript-runtime-project";

export interface GeneratedTypescriptCdkInfrastructureProjectOptions
  extends GeneratedTypeScriptInfrastructureOptions,
    CodeGenerationSourceOptions {
  /**
   * Generated typescript types project
   */
  readonly generatedTypescriptTypes: GeneratedTypescriptRuntimeProject;

  /**
   * Generated handlers projects
   */
  readonly generatedHandlers: GeneratedHandlersProjects;

  /**
   * Whether the infrastructure and client projects are parented by an monorepo or not
   */
  readonly isWithinMonorepo?: boolean;
}

export class GeneratedTypescriptCdkInfrastructureProject extends TypeScriptProject {
  /**
   * Options configured for the project
   * @private
   */
  private readonly options: GeneratedTypescriptCdkInfrastructureProjectOptions;

  /**
   * Path to the packaged copy of the openapi specification
   * @private
   */
  private readonly packagedSpecPath = "assets/api.json";

  constructor(options: GeneratedTypescriptCdkInfrastructureProjectOptions) {
    super({
      ...(options as any),
      sampleCode: false,
      jest: false,
      eslint: false,
      prettier: false,
      tsconfig: {
        compilerOptions: {
          lib: ["dom", "es2019"],
          // Generated code imports all models, and may not reference them all
          noUnusedLocals: false,
          noUnusedParameters: false,
          skipLibCheck: true,
          ...options?.tsconfig?.compilerOptions,
        },
      },
      npmignoreEnabled: false,
    });
    TypeSafeApiCommandEnvironment.ensure(this);
    this.options = options;

    this.addDevDeps("@types/aws-lambda");
    this.addDeps(
      ...[
        // If within a monorepo, add a regular dependency. Otherwise, use a file dependency to ensure the types can be
        // resolved
        options.isWithinMonorepo
          ? `${options.generatedTypescriptTypes.package.packageName}@${options.generatedTypescriptTypes.package.manifest.version}`
          : `${
              options.generatedTypescriptTypes.package.packageName
            }@file:${path.relative(
              this.outdir,
              options.generatedTypescriptTypes.outdir
            )}`,
      ].filter(
        (dep) => !this.deps.tryGetDependency(dep, DependencyType.RUNTIME)
      )
    );

    const devAndPeerDeps = ["@aws/pdk", "constructs", "aws-cdk-lib", "cdk-nag"];
    this.addDevDeps(
      ...devAndPeerDeps.filter(
        (dep) => !this.deps.tryGetDependency(dep, DependencyType.BUILD)
      )
    );
    this.addPeerDeps(
      ...devAndPeerDeps.filter(
        (dep) => !this.deps.tryGetDependency(dep, DependencyType.PEER)
      )
    );

    // Minimal .npmignore to avoid impacting OpenAPI Generator
    const npmignore = new IgnoreFile(this, ".npmignore");
    npmignore.addPatterns("/.projen/", "/src", "/dist");

    // Ignore everything but the target files
    const openapiGeneratorIgnore = new OpenApiGeneratorIgnoreFile(this);
    openapiGeneratorIgnore.addPatterns(
      "/*",
      "**/*",
      "*",
      `!${this.srcdir}/index.ts`,
      `!${this.srcdir}/api.ts`,
      `!${this.srcdir}/mock-integrations.ts`
    );

    const openapiGeneratorHandlebarsIgnore =
      new OpenApiGeneratorHandlebarsIgnoreFile(this);
    openapiGeneratorHandlebarsIgnore.addPatterns(
      "/*",
      "**/*",
      "*",
      `!${this.srcdir}/__functions.ts`
    );

    // Add OpenAPI Generator cli configuration
    OpenApiToolsJsonFile.ensure(this).addOpenApiGeneratorCliConfig(
      options.openApiGeneratorCliConfig
    );

    const generateTask = this.addTask("generate");
    generateTask.exec(buildCleanOpenApiGeneratedCodeCommand());
    generateTask.exec(
      buildTypeSafeApiExecCommand(
        TypeSafeApiScript.GENERATE,
        this.buildGenerateCommandArgs()
      )
    );
    if (!this.options.mockDataOptions?.disable) {
      generateTask.exec(this.buildGenerateMockDataCommand());
    }

    // Copy the api spec to within the package
    generateTask.exec(`mkdir -p ${path.dirname(this.packagedSpecPath)}`);
    generateTask.exec(
      `cp -f ${this.options.specPath} ${this.packagedSpecPath}`
    );
    this.gitignore.addPatterns(`/${this.packagedSpecPath}`);

    this.preCompileTask.spawn(generateTask);

    // Ignore the generated code
    this.gitignore.addPatterns(this.srcdir, ".openapi-generator", "mocks");

    // If we're not in a monorepo, we need to link the generated types such that the local dependency can be resolved
    if (!options.isWithinMonorepo) {
      switch (this.package.packageManager) {
        case NodePackageManager.PNPM:
          this.tasks
            .tryFind("install")
            ?.prependExec(
              `${this.package.packageManager} link /${path.relative(
                this.outdir,
                this.options.generatedTypescriptTypes.outdir
              )}`
            );
          break;
        default:
          this.tasks
            .tryFind("install")
            ?.prependExec(
              `${this.package.packageManager} link ${this.options.generatedTypescriptTypes.package.packageName}`
            );
          break;
      }
    }
  }

  public buildGenerateCommandArgs = () => {
    return buildInvokeOpenApiGeneratorCommandArgs({
      generator: "typescript-fetch",
      specPath: this.options.specPath,
      generatorDirectory: OtherGenerators.TYPESCRIPT_CDK_INFRASTRUCTURE,
      srcDir: this.srcdir,
      normalizers: {
        KEEP_ONLY_FIRST_TAG_IN_OPERATION: true,
      },
      extraVendorExtensions: {
        "x-runtime-package-name":
          this.options.generatedTypescriptTypes.package.packageName,
        // Spec path relative to the source directory
        "x-relative-spec-path": path.join("..", this.packagedSpecPath),
        // Enable mock integration generation by default
        "x-enable-mock-integrations": !this.options.mockDataOptions?.disable,
        ...getHandlersProjectVendorExtensions(
          this,
          this.options.generatedHandlers
        ),
      },
    });
  };

  public buildGenerateMockDataCommand = () => {
    return buildInvokeMockDataGeneratorCommand({
      specPath: this.options.specPath,
      ...this.options.mockDataOptions,
    });
  };
}
