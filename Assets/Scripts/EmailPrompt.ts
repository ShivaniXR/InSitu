/**
 * One-time destination entry.
 *
 * Typing on glasses is slow and a mistyped address fails silently, so this is asked
 * once and remembered — every export after the first sends without any input.
 */
export class EmailPrompt {
  private static open = false;

  static isValid(v: string): boolean {
    const at = v.indexOf("@");
    const dot = v.lastIndexOf(".");
    return at > 0 && dot > at + 1 && dot < v.length - 1 && v.indexOf(" ") < 0;
  }

  /**
   * Show the keyboard and hand back what was typed.
   * `onCancel` fires when the field is dismissed without a usable address.
   */
  static ask(
    seed: string,
    onType: (partial: string) => void,
    onDone: (email: string) => void,
    onCancel: () => void
  ) {
    if (EmailPrompt.open) return;
    const G: any = global as any;
    if (!G.textInputSystem || !G.TextInputSystem) { onCancel(); return; }

    let current = seed || "";
    let settled = false;   // the commit path fires twice; only act once

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      EmailPrompt.open = false;
      try { G.textInputSystem.dismissKeyboard(); } catch (e) { /* already gone */ }
      if (ok && EmailPrompt.isValid(current)) onDone(current.trim());
      else onCancel();
    };

    try {
      const opts = new G.TextInputSystem.KeyboardOptions();
      opts.enablePreview = true;
      opts.keyboardType = G.TextInputSystem.KeyboardType.Email;
      opts.returnKeyType = G.TextInputSystem.ReturnKeyType.Done;

      opts.onTextChanged = (text: string) => {
        current = text;
        onType(text);
      };
      opts.onKeyboardStateChanged = (isOpen: boolean) => {
        if (!isOpen) finish(true);
      };

      EmailPrompt.open = true;
      G.textInputSystem.requestKeyboard(opts);
      print("[Email] keyboard open, seed='" + current + "'");
    } catch (e) {
      print("[Email] keyboard failed: " + e);
      EmailPrompt.open = false;
      onCancel();
    }
  }
}
