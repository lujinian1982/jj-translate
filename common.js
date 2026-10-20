// Shared settings and constants. Loaded by background (importScripts),
// content scripts (before content.js / youtube.js) and the extension pages.
const LT = (() => {
  const LANGS = [
    ['zh-CN', '简体中文', 'Simplified Chinese'],
    ['zh-TW', '繁體中文', 'Traditional Chinese'],
    ['en', 'English', 'English'],
    ['ja', '日本語', 'Japanese'],
    ['ko', '한국어', 'Korean'],
    ['fr', 'Français', 'French'],
    ['de', 'Deutsch', 'German'],
    ['es', 'Español', 'Spanish'],
    ['ru', 'Русский', 'Russian'],
  ];

  const THEMES = [
    ['none', '无样式'],
    ['dashed', '虚线下划线'],
    ['underline', '下划线'],
    ['wavy', '波浪线'],
    ['highlight', '背景高亮'],
    ['blockquote', '左侧竖线'],
    ['faded', '半透明'],
    ['italic', '斜体'],
  ];

  const PRESETS = {
    deepseek: {
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      temperature: 0.3,
      jsonMode: true,
      extraBody: '',
    },
    zhipu: {
      name: '智谱 GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-flash',
      temperature: 0.3,
      jsonMode: true,
      extraBody: '',
    },
  };

  const BATCH_SYSTEM_PROMPT = [
    'You are a translation engine. The user sends JSON in the form {"items": ["...", "..."]}.',
    'Translate every item into {{to}}.',
    'Rules:',
    '- Keep the meaning, tone and line breaks of each item.',
    '- Leave code, URLs, e-mail addresses, numbers and product names unchanged when they should not be translated.',
    '- If an item is already in {{to}}, or has nothing to translate, return it unchanged.',
    '- Do not merge, split, skip or reorder items. Do not add notes.',
    'Reply with JSON only, in the form {"translations": ["...", "..."]}, with exactly the same number of items as the input.',
  ].join('\n');

  const SINGLE_SYSTEM_PROMPT = [
    "You are a translation engine. Translate the user's text into {{to}}.",
    'Keep the meaning, tone and line breaks.',
    'Output only the translation, with no notes, quotes or explanations.',
  ].join('\n');

  const DEFAULTS = {
    targetLang: 'zh-CN',
    inputTargetLang: 'en',
    mode: 'bilingual', // bilingual | translation
    theme: 'dashed',
    profiles: [{ id: 'deepseek', apiKey: '', ...PRESETS.deepseek }],
    activeProfileId: 'deepseek',
    batchSize: 8,
    maxCharsPerBatch: 2500,
    concurrency: 4,
    inputTrigger: true,
    youtubeEnabled: true,
    youtubeShowOriginal: true,
    babeldocUrl: '', // set your own BabelDOC address in the options page
    systemPrompt: '',
  };

  async function getSettings() {
    const stored = await chrome.storage.local.get(null);
    const s = { ...DEFAULTS, ...stored };
    if (!Array.isArray(s.profiles) || !s.profiles.length) s.profiles = DEFAULTS.profiles;
    return s;
  }

  function activeProfile(s) {
    return s.profiles.find((p) => p.id === s.activeProfileId) || s.profiles[0];
  }

  function langLabel(code) {
    const l = LANGS.find((x) => x[0] === code);
    return l ? l[1] : code;
  }

  function promptLangName(code) {
    const l = LANGS.find((x) => x[0] === code);
    return l ? l[2] : code;
  }

  return {
    LANGS, THEMES, PRESETS, DEFAULTS,
    BATCH_SYSTEM_PROMPT, SINGLE_SYSTEM_PROMPT,
    getSettings, activeProfile, langLabel, promptLangName,
  };
})();
