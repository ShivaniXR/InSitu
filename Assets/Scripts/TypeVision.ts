import { OpenAI } from "RemoteServiceGateway.lspkg/HostedExternal/OpenAI";

/**
 * Reads lettering in a photo and suggests typefaces you can actually use.
 *
 * Deliberately NOT font identification. A vision model asked "what font is this" will
 * confidently answer "Helvetica Neue" for almost any sans, and our input — a crop off a
 * handheld frame, at an angle, in whatever light the street has — is far worse than
 * what a real matcher like WhatTheFont works from. Worse, a correct answer is often
 * useless: you cannot set type in a shopfront's custom lettering.
 *
 * So the model does what it is genuinely good at — judging visual style — and maps that
 * onto faces already loaded in the project. The answer is always actionable.
 */
export type TypeReading = {
  style: string;      // "high-contrast didone", "geometric grotesque"
  families: string[]; // ordered best-first, constrained to what we actually have
  note: string;       // one line a designer would say
};

export class TypeVision {
  /**
   * @param jpegBase64 the crop, no data: prefix
   * @param available the families loaded in the project — the model may only pick these
   */
  static read(
    jpegBase64: string,
    available: string[],
    onDone: (r: TypeReading) => void,
    onFail: (msg: string) => void
  ) {
    const system =
      "You are a typographer helping build a mood board. " +
      "Look at the lettering in the image. Do NOT attempt to name the exact typeface — " +
      "you cannot know it from a photograph and guessing would mislead. " +
      "Instead describe its style, then recommend the closest matches from the list of " +
      "available typefaces you are given. Only ever recommend from that list.";

    const user =
      "Available typefaces: " + available.join(", ") + ".\n" +
      "Reply as JSON with exactly these keys:\n" +
      '  "style": two to four words for the letterforms, e.g. "high-contrast didone"\n' +
      '  "families": up to three names from the available list, best match first\n' +
      '  "note": one short sentence a designer would say about the character.';

    let request: any;
    try {
      request = {
        model: "gpt-4o",
        response_format: { type: "json_object" },
        max_tokens: 300,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text", text: user },
              {
                type: "image_url",
                image_url: {
                  url: "data:image/jpeg;base64," + jpegBase64,
                  detail: "high",
                },
              },
            ],
          },
        ],
      };
    } catch (e) {
      onFail("could not build request: " + e);
      return;
    }

    print("[TypeVision] asking, image " + jpegBase64.length + " b64 chars");

    OpenAI.chatCompletions(request)
      .then((res: any) => {
        let text = "";
        try {
          text = res.choices[0].message.content;
        } catch (e) {
          onFail("unexpected response shape");
          return;
        }

        let parsed: any = null;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          onFail("model did not return JSON");
          return;
        }

        // never trust the model to respect the list - filter to what we actually have
        const fams: string[] = [];
        const want = parsed.families || [];
        for (let i = 0; i < want.length; i++) {
          for (let k = 0; k < available.length; k++) {
            if (available[k] === want[i] && fams.indexOf(want[i]) < 0) {
              fams.push(want[i]);
            }
          }
        }

        onDone({
          style: parsed.style ? String(parsed.style) : "",
          families: fams,
          note: parsed.note ? String(parsed.note) : "",
        });
      })
      .catch((e: any) => onFail("request failed: " + e));
  }
}
