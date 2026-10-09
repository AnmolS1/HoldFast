// ESLint rule "holdfast/accent-guard" (design direction §2, "Theme guard").
//
// The activity colour means one thing — something is happening — so its tokens and
// `palette.primary` may be referenced only by the progress, selection and live-count components
// and by the theme itself:
//
//   src/client/theme/**
//   src/client/components/{TransferRibbon,SelectionBar,StatusDot,ProgressUnderline}/**
//
// Everywhere else under src/client the rule reports identifiers, strings, template text and
// comments that name the colour (the word itself, in any casing), and every way of reaching
// `palette.primary` (member access, "primary.main"-style strings, the CSS variable).
// Comments are included on purpose: the verification grep is plain text, and the two must agree.
//
// Wiring (flat config):
//   import accentGuard from "./src/client/theme/eslint-accent-guard.mjs";
//   { files: ["src/client/**/*.{ts,tsx}"], plugins: { holdfast: accentGuard }, rules: { "holdfast/accent-guard": "error" } }

export const ALLOWED =
  /(^|\/)src\/client\/(theme|components\/(TransferRibbon|SelectionBar|StatusDot|ProgressUnderline))\//;
const SCOPE = /(^|\/)src\/client\//;

const WORD = /accent/i;
const PRIMARY_TEXT = /palette\.primary|palette-primary|\bprimary\.(main|light|dark|contrastText)\b/;

function isScoped(filename) {
  const normalised = filename.replace(/\\/g, "/");
  return SCOPE.test(normalised) && !ALLOWED.test(normalised);
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "the activity colour and palette.primary are referenced only by the allow-listed components and the theme",
    },
    schema: [],
    messages: {
      accent:
        'The activity colour may be referenced only in theme/ and in TransferRibbon, SelectionBar, StatusDot and ProgressUnderline. Use `aria-selected` inside a `data-hf-list` container, `<Button variant="cta">`, or one of the four components.',
      primary: "`palette.primary` may be referenced only in theme/ and the four allow-listed components.",
    },
  },
  create(context) {
    if (!isScoped(context.filename ?? context.getFilename())) return {};
    const text = (node, value) => {
      if (typeof value !== "string") return;
      if (WORD.test(value)) context.report({ node, messageId: "accent" });
      else if (PRIMARY_TEXT.test(value)) context.report({ node, messageId: "primary" });
    };
    const isPalette = (node) =>
      (node.type === "Identifier" && node.name === "palette") ||
      (node.type === "MemberExpression" &&
        !node.computed &&
        node.property.type === "Identifier" &&
        node.property.name === "palette");
    return {
      Program(node) {
        const source = context.sourceCode ?? context.getSourceCode();
        for (const comment of source.getAllComments()) {
          if (WORD.test(comment.value)) context.report({ loc: comment.loc, messageId: "accent" });
          else if (PRIMARY_TEXT.test(comment.value))
            context.report({ loc: comment.loc, messageId: "primary" });
        }
        void node;
      },
      Identifier(node) {
        if (WORD.test(node.name)) context.report({ node, messageId: "accent" });
      },
      JSXIdentifier(node) {
        if (WORD.test(node.name)) context.report({ node, messageId: "accent" });
      },
      Literal(node) {
        text(node, node.value);
      },
      JSXText(node) {
        text(node, node.value);
      },
      TemplateElement(node) {
        text(node, node.value.raw);
      },
      MemberExpression(node) {
        if (!isPalette(node.object)) return;
        const name = node.computed
          ? node.property.type === "Literal"
            ? node.property.value
            : null
          : node.property.name;
        if (name === "primary") context.report({ node, messageId: "primary" });
      },
    };
  },
};

const plugin = { meta: { name: "holdfast" }, rules: { "accent-guard": rule } };

export default plugin;
