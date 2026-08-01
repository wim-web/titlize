import { describe, expect, test } from "bun:test";
import { TitleValidationError, validateTitle } from "../src/title-validator";

describe("validateTitle", () => {
  test("見出しと日本語の引用符を取り除く", () => {
    expect(validateTitle("# 『認証エラーの修正』", 40)).toBe("認証エラーの修正");
  });

  test("コードフェンスの行だけを除去し、中身を保持する", () => {
    expect(validateTitle("```\n認証エラーの修正\n```", 40)).toBe("認証エラーの修正");
    expect(validateTitle("```markdown\n# 認証エラーの修正\n```", 40)).toBe("認証エラーの修正");
  });

  test("改行と空白を畳み、各種行頭マーカーを取り除く", () => {
    expect(
      validateTitle(">   - 認証\r\n2)\tエラー\r* 修正", 40),
    ).toBe("認証 エラー 修正");
  });

  test("リンク、画像、インラインコード、強調を表示テキストへ正規化する", () => {
    expect(
      validateTitle("[**認証**](https://example.test) ![エラー](image.png) `修正` ~~完了~~", 40),
    ).toBe("認証 エラー 修正 完了");
  });

  test("生のURLを勝手に変更しない", () => {
    expect(validateTitle("https://example.test/auth_error_details", 40)).toBe(
      "https://example.test/auth_error_details",
    );
  });

  test("外側の引用符と強調を反復して除去し、内側の引用符は保持する", () => {
    expect(validateTitle("# 『**「認証」エラー**』", 40)).toBe("「認証」エラー");
  });

  test("対応しない引用符は取り除かない", () => {
    expect(validateTitle("『認証エラー", 40)).toBe("『認証エラー");
  });

  test("空またはマークアップだけのタイトルを拒否する", () => {
    for (const raw of ["", " \n\t ", "```\n```", "# ", "> ", "- ", "1. "]) {
      expect(() => validateTitle(raw, 40)).toThrow(TitleValidationError);
    }
  });

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "正の安全整数ではない上限を拒否する: %s",
    (maxChars) => {
      expect(() => validateTitle("認証エラー", maxChars)).toThrow(TitleValidationError);
    },
  );

  test("日本語と絵文字はコードポイントで上限ちょうどを受け入れる", () => {
    expect(validateTitle("認証🔧", 3)).toBe("認証🔧");
  });

  test("上限超過を切り詰めず拒否し、raw titleをエラーに含めない", () => {
    const raw = "秘密の認証エラー🔧";
    let error: unknown;

    try {
      validateTitle(raw, 3);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TitleValidationError);
    expect((error as Error).name).toBe("TitleValidationError");
    expect((error as Error).message).not.toContain(raw);
    expect((error as Error & { cause?: unknown }).cause).not.toBe(raw);
  });
});
