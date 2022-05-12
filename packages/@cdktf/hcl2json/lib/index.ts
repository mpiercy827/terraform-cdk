// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference lib="dom" />

// Inspired by
// https://github.com/ts-terraform/ts-terraform
// https://github.com/aaronpowell/webpack-golang-wasm-async-loader

import fs from "fs-extra";
import path from "path";
import { Go } from "./wasm_exec";
import { deepMerge } from "./deepmerge";
import { gunzipSync } from "zlib";

interface GoBridge {
  parse: (filename: string, hcl: string) => Promise<string>;
  getReferencesInExpression: (filename: string, hcl: string) => Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/ban-types
const jsRoot: Record<string, Function> = {};

function sleep() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function goBridge(getBytes: Promise<Buffer>) {
  let ready = false;

  async function init() {
    const go = new Go();
    const bytes = await getBytes;
    const result = await WebAssembly.instantiate(bytes, go.importObject);
    void go.run(result.instance, { __parse_terraform_config_wasm__: jsRoot });
    ready = true;
  }

  init().catch((error) => {
    throw error;
  });

  const proxy = new Proxy({} as GoBridge, {
    get: (_, key: string) => {
      return async (...args: unknown[]) => {
        while (!ready) {
          await sleep();
        }

        if (!(key in jsRoot)) {
          throw new Error(
            `There is nothing defined with the name "${key.toString()}"`
          );
        }

        if (typeof jsRoot[key] !== "function") {
          return jsRoot[key];
        }

        return new Promise((resolve, reject) => {
          const cb = (err: string, ...msg: string[]) =>
            // @ts-ignore
            err ? reject(new Error(err)) : resolve(...msg);

          const run = () => {
            jsRoot[key].apply(undefined, [...args, cb]);
          };

          run();
        });
      };
    },
  });

  return proxy;
}

const loadWasm = async () => {
  return gunzipSync(
    await fs.readFile(path.join(__dirname, "..", "main.wasm.gz"))
  );
};

const wasm = goBridge(loadWasm());

export async function parse(
  filename: string,
  contents: string
): Promise<Record<string, any>> {
  const res = await wasm.parse(filename, contents);
  return JSON.parse(res);
}

export async function convertFiles(
  workingDirectory: string
): Promise<Record<string, any> | void> {
  let tfFileContents = "";
  const tfJSONFileContents: Record<string, any>[] = [];

  for (const file of fs.readdirSync(workingDirectory)) {
    const filePath = path.resolve(workingDirectory, file);
    if (!fs.lstatSync(filePath).isDirectory()) {
      if (file.match(/\.tf$/)) {
        tfFileContents += fs.readFileSync(filePath, "utf-8");
        tfFileContents += "\n";
      } else if (file.match(/\.tf\.json$/)) {
        tfJSONFileContents.push(JSON.parse(fs.readFileSync(filePath, "utf-8")));
      }
    }
  }

  if (tfFileContents === "" && tfJSONFileContents === []) {
    console.error(`No '.tf' or '.tf.json' files found in ${workingDirectory}`);
    return;
  }

  return deepMerge(
    await parse("hcl2json.tf", tfFileContents),
    ...tfJSONFileContents
  );
}

type CodeMarker = {
  Byte: number;
  Line: number;
  Column: number;
};
type Range = {
  End: CodeMarker;
  Start: CodeMarker;
};
type TerraformTraversalPart = {
  Name: string;
  SrcRange: Range;
};
// Reference to a variable / module / resource
type TerraformTraversal = { Traversal: TerraformTraversalPart[] };
type TerraformFunctionCall = {
  Args: TerraformObject[];
  Name: string;
  ExpandFinal: boolean;
  NameRange: Range;
  OpenParenRange: Range;
  CloseParenRange: Range;
};
type TerraformLiteral = {
  SrcRange: Range;
  Val: unknown; // No value is passed down, we ignore them
};
type TerraformEmbeddedExpression = {
  Wrapped: TerraformObject;
};
type TerraformExpression = {
  Parts: TerraformObject[];
};
type TerraformObject =
  | TerraformEmbeddedExpression
  | TerraformExpression
  | TerraformFunctionCall
  | TerraformLiteral
  | TerraformTraversal;

type GoExpressionParseResult = null | TerraformObject;

type Reference = { value: string; startPosition: number; endPosition: number };

function traversalToReference(traversal: TerraformTraversal): Reference {
  if (
    traversal.Traversal.find(
      (part) => part.SrcRange.Start.Line !== 0 || part.SrcRange.End.Line !== 0
    )
  ) {
    throw new Error(`Parsed references are expected to be a single line`);
  }

  return {
    value: traversal.Traversal.map((part) => part.Name).join("."),
    startPosition: traversal.Traversal[0].SrcRange.Start.Column,
    endPosition:
      traversal.Traversal[traversal.Traversal.length - 1].SrcRange.End.Column,
  };
}

function findAllReferencesInAst(entry: TerraformObject): Reference[] {
  if ("Traversal" in entry) {
    return [traversalToReference(entry)];
  }

  if ("Parts" in entry) {
    return entry.Parts.reduce(
      (carry, part) => [...carry, ...findAllReferencesInAst(part)],
      [] as Reference[]
    );
  }

  if ("Wrapped" in entry) {
    return findAllReferencesInAst(entry.Wrapped);
  }

  if ("Args" in entry) {
    return entry.Args.reduce(
      (carry, arg) => [...carry, ...findAllReferencesInAst(arg)],
      [] as Reference[]
    );
  }

  return [];
}

export async function getReferencesInExpression(
  filename: string,
  expression: string
): Promise<Reference[]> {
  const res = await wasm.getReferencesInExpression(
    filename,
    JSON.stringify(expression)
  );
  const ast = JSON.parse(res) as GoExpressionParseResult;

  if (!ast) {
    return [];
  }

  return findAllReferencesInAst(ast);
}
