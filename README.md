# JJ的沉浸翻译

一个精简版的沉浸式双语翻译 Chrome 扩展。模型 API 由你自己配置（DeepSeek、智谱 GLM，或任何 OpenAI 兼容接口）。

## 功能

| 功能 | 用法 |
| --- | --- |
| 网页双语对照翻译 | 点弹窗里的“翻译此页”，或按 `Alt+A`。再按一次恢复原文 |
| 仅显示译文 | 弹窗里选“仅译文” |
| 译文样式 | 弹窗里选：虚线、下划线、波浪线、高亮、竖线、半透明、斜体 |
| 输入框翻译 | 在输入框末尾连按 3 次空格，或按 `Alt+I`。目标语言在设置页改 |
| YouTube 字幕 | 打开视频的 CC 字幕后自动翻译整条字幕，显示“译文 + 原文” |
| PDF 翻译 | 在设置页填写你部署的 BabelDOC 地址，然后在弹窗里点“PDF 翻译（BabelDOC）” |

## 安装

1. 打开 `chrome://extensions`。
2. 打开右上角的“开发者模式”。
3. 点“加载已解压的扩展程序”，选择本文件夹 `lite-translate`。
4. 在扩展的设置页填写 API Key，点“测试连接”，再点“保存”。

## 模型配置

| 服务 | Base URL | 模型名 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash`（免费）、`glm-4-air` |

智谱 GLM-4.5 以上的模型默认会先“思考”，速度慢。在“额外请求参数”里填 `{"thinking":{"type":"disabled"}}` 可以关闭思考。

## 工作原理

1. `content.js` 找出页面里的段落，只处理接近屏幕的段落。
2. 每 8 段合成一次请求，发给 `background.js`。
3. `background.js` 用 JSON 格式调用 `/chat/completions`，按顺序拆回译文。条数不符时，改为逐段翻译。
4. 译文插在原段落后面的 `<lt-trans>` 元素里。
5. YouTube：`yt_main.js` 在页面里截获播放器下载的字幕（`/api/timedtext`），`youtube.js` 翻译整条字幕，再按播放时间显示。

## 测试

```bash
node test/background.test.js
```

`test/harness.html` 和 `test/yt.html` 用模拟的扩展 API 测试网页翻译和字幕逻辑。用任意本地 HTTP 服务器打开它们即可。

## 已知限制

- 译文是纯文本，不保留原段落里的链接和加粗。
- 只处理顶层页面，不处理 iframe。
- YouTube 只支持 json3 字幕格式（网页版播放器的默认格式）。
- BabelDOC 只是打开你的站点，PDF 需要在那里上传。

## 许可证

MIT，见 [LICENSE](LICENSE)。
