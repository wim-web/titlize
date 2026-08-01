import { describe, expect, test } from "bun:test";
import { TitleValidationError, validateTitle } from "../src/title-validator";

describe("validateTitle", () => {
  test("見出しと日本語の引用符を取り除く", () => {
    expect(validateTitle("# 『認証エラーの修正』", 40)).toBe("認証エラーの修正");
  });

  test("正規化前の入力が4096 code unitsを超える場合は上限を拒否する", () => {
    expect(() => validateTitle("a".repeat(4097), Number.MAX_SAFE_INTEGER)).toThrow(TitleValidationError);
    expect(validateTitle(`${"「".repeat(1000)}認証${"」".repeat(1000)}`, 40)).toBe("認証");
    expect(() => validateTitle(`${"「".repeat(2048)}認証${"」".repeat(2048)}`, Number.MAX_SAFE_INTEGER)).toThrow(
      TitleValidationError,
    );
  });

  test("入力に含まれる旧placeholder文字列を変更しない", () => {
    const url = "https://x.test";
    expect(validateTitle("\uE0000\uE001", 40)).toBe("\uE0000\uE001");
    expect(validateTitle(`\uE0000\uE001 ${url}`, 40)).toBe(`\uE0000\uE001 ${url}`);
    expect(validateTitle("\uE0020\uE003", 40)).toBe("\uE0020\uE003");
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

  test("対応backtickを初回正規化で除去し、不一致backtickは保持する", () => {
    expect(validateTitle("`outer `inner` text`", 40)).toBe("outer inner text");
    expect(validateTitle("unmatched`", 40)).toBe("unmatched`");
    expect(validateTitle("通常 `inline` code", 40)).toBe("通常 inline code");
    expect(validateTitle(validateTitle("`outer `inner` text`", 40), 40)).toBe("outer inner text");
  });

  test("入れ子のURL placeholderを漏らさず復元する", () => {
    const normalized = validateTitle("`https://example.test/a`inner``", 200);
    expect(normalized).toBe("https://example.test/ainner");
    expect(validateTitle(normalized, 200)).toBe(normalized);
  });

  test.each(['""', "''", "``", "“”", "‘’", "「」", "『』", "【】"])(
    "空の対応引用符を空タイトルとして拒否する: %s",
    (raw) => {
      expect(() => validateTitle(raw, 40)).toThrow(TitleValidationError);
    },
  );

  test("任意に深い対応引用符をすべて剥がす", () => {
    expect(validateTitle(`${"「".repeat(64)}認証${"」".repeat(64)}`, 40)).toBe("認証");
  });

  test("単語内のunderscoreを保持し、強調マーカーだけを除去する", () => {
    expect(validateTitle("foo_bar_baz a__b__c", 40)).toBe("foo_bar_baz a__b__c");
    expect(validateTitle("**bold** __bold__ ~~strike~~ *em* _em_", 40)).toBe("bold bold strike em em");
  });

  test("演算子風・escape済みの強調記号を保持する", () => {
    expect(validateTitle("2 * 3 * 4", 40)).toBe("2 * 3 * 4");
    expect(validateTitle("foo ** bar ** baz", 40)).toBe("foo ** bar ** baz");
    expect(validateTitle("\\*literal* \\_literal_", 40)).toBe("\\*literal* \\_literal_");
  });

  test("代表ケースの正規化は冪等である", () => {
    const raw = '"# 『**[認証](https://example.test) エラー**』"';
    const normalized = validateTitle(raw, 40);
    expect(validateTitle(normalized, 40)).toBe(normalized);
  });

  test("記号と括弧を含む生URLを一字も変更しない", () => {
    expect(validateTitle("https://example.test/a/**segment**?x=~ok~_(v)", 60)).toBe(
      "https://example.test/a/**segment**?x=~ok~_(v)",
    );
  });

  test("URL内部のapostrophe後にあるMarkdown風文字列を変更しない", () => {
    expect(validateTitle("https://example.test/a'**b**", 60)).toBe("https://example.test/a'**b**");
    expect(validateTitle("https://example.test/a'_b_", 60)).toBe("https://example.test/a'_b_");
    expect(validateTitle("https://example.test/a'~~b~~", 60)).toBe("https://example.test/a'~~b~~");
  });

  test("apostropheで囲んだURLの外側Markdownを除去し、裸URLの内部apostropheは保持する", () => {
    expect(validateTitle("**'https://example.test/a'**", 200)).toBe("https://example.test/a");
    expect(validateTitle("https://example.test/a'**b**", 200)).toBe("https://example.test/a'**b**");
  });

  test("PUAを多く含む入力とURLを衝突なく正規化する", () => {
    const pua = "\uE100";
    const raw = `${pua}https://x.test ${pua}https://x.test`;
    expect(validateTitle(raw, 200)).toBe(raw);
    expect(validateTitle(`${pua.repeat(4000)} https://x.test`, 4096)).toBe(`${pua.repeat(4000)} https://x.test`);
  });

  test("URLを囲むMarkdownだけを除去し、囲まれていないURL末尾記号は保持する", () => {
    expect(validateTitle("**https://example.test/a_b**", 60)).toBe("https://example.test/a_b");
    expect(validateTitle("~~https://example.test/a~~", 60)).toBe("https://example.test/a");
    expect(validateTitle("See `https://example.test/a` now", 60)).toBe("See https://example.test/a now");
    expect(validateTitle("https://example.test/a**?x=~ok~_`", 60)).toBe("https://example.test/a**?x=~ok~_`");
  });

  test("URL直前後のMarkdown境界だけを分離し、句読点を保持する", () => {
    expect(validateTitle("***https://example.test/a***", 60)).toBe("https://example.test/a");
    expect(validateTitle("**https://example.test/a**.", 60)).toBe("https://example.test/a.");
    expect(validateTitle("See `https://example.test/a`, now", 60)).toBe("See https://example.test/a, now");
    expect(validateTitle("『「https://example.test/a」』", 60)).toBe("https://example.test/a");
    expect(validateTitle("**「https://example.test/a」**", 60)).toBe("https://example.test/a");
  });

  test("入れ子の強調で囲まれたURLから強調だけを除去する", () => {
    expect(validateTitle("**_https://example.test/a_**", 60)).toBe("https://example.test/a");
    expect(validateTitle("_**https://example.test/a**_", 60)).toBe("https://example.test/a");
    expect(validateTitle("**~~https://example.test/a~~**", 60)).toBe("https://example.test/a");
    expect(validateTitle("(**https://example.test/a**)", 60)).toBe("(https://example.test/a)");
    expect(validateTitle("[**https://example.test/a**]", 60)).toBe("[https://example.test/a]");
  });

  test("孤立backtickを保持し、空の対応backtickだけを拒否する", () => {
    expect(validateTitle("`", 1)).toBe("`");
    expect(() => validateTitle("``", 1)).toThrow(TitleValidationError);
  });

  test("括弧を含むリンク先でも表示テキストだけを保持する", () => {
    expect(validateTitle("[label](https://example.test/a_(b))", 40)).toBe("label");
    expect(validateTitle("![alt](https://example.test/a_(b))", 40)).toBe("alt");
  });

  test("入れ子とescapeを含むリンクラベルを保持する", () => {
    expect(validateTitle("[a [b]](https://example.test)", 40)).toBe("a [b]");
    expect(validateTitle("![a [b]](https://example.test)", 40)).toBe("a [b]");
    expect(validateTitle("[a \\] b](https://example.test)", 40)).toBe("a \\] b");
  });

  test("空白付き情報文字列と4個以上のbacktick fenceを除去する", () => {
    expect(validateTitle(" ``` markdown \n認証\n ```` ", 40)).toBe("認証");
  });

  test("外側の引用符と強調を反復して除去し、内側の引用符は保持する", () => {
    expect(validateTitle("# 『**「認証」エラー**』", 40)).toBe("「認証」エラー");
  });

  test("対応しない引用符は取り除かない", () => {
    expect(validateTitle("『認証エラー", 40)).toBe("『認証エラー");
  });

  test.each([
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["“", "”"],
    ["‘", "’"],
    ["「", "」"],
    ["『", "』"],
    ["【", "】"],
  ])("対応する引用符 %s…%s を取り除く", (opening, closing) => {
    expect(validateTitle(`${opening}認証${closing}`, 40)).toBe("認証");
  });

  test("内側の引用符は保持し、外側の引用符で露出したMarkdownを反復処理する", () => {
    expect(validateTitle('"# 『**タイトル**』"', 40)).toBe("タイトル");
    expect(validateTitle("『「認証」』", 40)).toBe("認証");
    expect(validateTitle("「認証』", 40)).toBe("「認証』");
  });

  test("空またはマークアップだけのタイトルを拒否する", () => {
    for (const raw of ["", " \n\t ", "```\n```", "# ", "> ", "- ", "1. ", "**", "__", "~~", "****", "____", "~~~~", "***", "___"]) {
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
