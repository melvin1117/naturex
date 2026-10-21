/**
 * What a browser does to a focused button that becomes disabled: focus falls to `<body>`.
 * jsdom keeps it there (and `blur()` on a disabled button is a no-op), so tests call this.
 */
export function dropFocus(): void {
  const sink = document.createElement("input");
  document.body.append(sink);
  sink.focus();
  sink.remove();
}
