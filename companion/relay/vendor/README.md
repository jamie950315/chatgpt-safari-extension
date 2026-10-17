# Babel Standalone 7.28.5

`BabelStandalone.js` is the unmodified `babel.min.js` from
`@babel/standalone@7.28.5` (MIT; see `BabelStandalone.LICENSE`).

The native provider relay uses its async-generator transform in a separate
JavaScriptCore compilation context. Provider code is parsed, never executed
there. Original public module URLs and application logic remain unchanged;
only the inspected stream factories `sY`, `tI`, and `dd` are compiled to the
ordinary generator/Promise protocol to avoid a reproduced WebKit crash.
Helpers are isolated inside each factory's closure. Other factories are not
transformed.

Acquire a replacement explicitly with `npm pack @babel/standalone@<version>` and
extract `package/babel.min.js` and `package/LICENSE`. Re-run the real relay
transform/streaming test and installed Safari flow after an update.
