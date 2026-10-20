# JJ的沉浸翻译 (JJ Immersive Translate)

English | [简体中文](README.zh-CN.md)

A lightweight Chrome extension for bilingual web page translation. You bring your own model API: DeepSeek, Zhipu GLM, or any OpenAI-compatible endpoint.

The user interface is in Chinese. This README gives each Chinese label with its English meaning.

## Features

| Feature | How to use |
| --- | --- |
| Bilingual page translation | Click 翻译此页 (Translate this page) in the popup, or press `Alt+A`. Press again to show the original page. |
| Translation-only mode | In the popup, select 仅译文 (Translation only). |
| Translation styles | In the popup, select a style: dashed underline, underline, wavy line, highlight, left bar, faded, or italic. |
| Input box translation | Type three spaces at the end of a text field, or press `Alt+I`. Set the target language in the options page. |
| YouTube subtitles | Turn on CC in a video. The extension translates the whole subtitle track and shows the translation above the original line. |
| PDF translation | Enter the address of your own BabelDOC deployment in the options page. Then click PDF 翻译（BabelDOC） in the popup. |

## Installation

1. Get the code: run `git clone https://github.com/lujinian1982/jj-translate.git`, or click Code → Download ZIP on GitHub and unzip it.
2. Open `chrome://extensions`.
3. Turn on Developer mode (top right).
4. Click Load unpacked and select the `jj-translate` folder.
5. Open the extension's options page. Enter your API key, click 测试连接 (Test connection), and then click 保存 (Save).

## Model configuration

| Provider | Base URL | Model |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` (free), `glm-4-air` |

The extension adds `/chat/completions` to the base URL. If the URL already ends with it, the extension uses the URL as is.

Zhipu GLM-4.5 and later models "think" before they answer, which makes translation slow. To turn thinking off, put `{"thinking":{"type":"disabled"}}` in the 额外请求参数 (Extra request parameters) field.

## How it works

1. `content.js` finds the paragraphs on the page. It translates only paragraphs near the visible area.
2. It sends paragraphs to `background.js` in batches of 8.
3. `background.js` calls `/chat/completions` and asks for a JSON reply. It splits the reply back into paragraphs in order. If the item count does not match, it translates each paragraph separately.
4. The extension inserts each translation in an `<lt-trans>` element after its source paragraph.
5. YouTube: `yt_main.js` captures the subtitle track that the player downloads (`/api/timedtext`). `youtube.js` translates the whole track and shows each line at its play time.

## Tests

```bash
node test/background.test.js
```

`test/harness.html` and `test/yt.html` test the page and subtitle logic with a mock extension API. Open them from any local HTTP server.

## Known limits

- Translations are plain text. Links and bold text in the source paragraph are not kept.
- Only the top-level page is translated, not iframes.
- YouTube support needs the json3 subtitle format, which is the default format of the web player.
- The BabelDOC button only opens your BabelDOC site. You upload the PDF there.

## License

MIT. See [LICENSE](LICENSE).
