import { getReferencesInExpression } from "../lib";

function parseExpression(expr: string) {
  return () =>
    expect(
      getReferencesInExpression("main.tf", expr)
    ).resolves.toMatchSnapshot();
}

describe("getReferencesInExpression", () => {
  test("parses a simple string", parseExpression("foo"));
  test("parses a reference string", parseExpression("${var.foo}"));
  test("parses three part references", parseExpression("${module.foo.output}"));
  test(
    "parses four part references",
    parseExpression("${data.type.name.attr}")
  );
  test(
    "parses a terraform function",
    parseExpression('${replace(module.foo.output, "-", var.bar)}')
  );

  test(
    "parses nested terraform functions",
    parseExpression(
      '${split(var.separator, lower(replace(module.foo.output, "-", var.bar)))}'
    )
  );

  test(
    "parses embedded vars",
    parseExpression("Hey, did you hear about ${module.foo.output}s new album?")
  );
  test(
    "parses lists",
    parseExpression('[5, ${module.foo.output}, "val", true]')
  );

  test(
    "parses maps",
    parseExpression(
      '{ x = ${module.foo.output}, y = "val", z = true, a = ${replace(module.foo.output, "-", var.bar)} }'
    )
  );

  test("fails on malformed expressions", () => {
    expect(
      getReferencesInExpression("main.tf", "${module.foo.output")
    ).rejects.toMatchSnapshot();
  });
});
