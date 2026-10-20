const $ = (s) => document.querySelector(s);

let s; // working copy of settings
let currentId;

function fillSelect(sel, items, value) {
  sel.replaceChildren(
    ...items.map(([v, label]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      return o;
    }),
  );
  if (value !== undefined) sel.value = value;
}

function current() {
  return s.profiles.find((p) => p.id === currentId);
}

function renderProfileList() {
  fillSelect($('#profileSel'), s.profiles.map((p) => [p.id, p.name || p.id]), currentId);
}

function showProfile() {
  const p = current();
  $('#pName').value = p.name || '';
  $('#pBase').value = p.baseUrl || '';
  $('#pKey').value = p.apiKey || '';
  $('#pModel').value = p.model || '';
  $('#pTemp').value = p.temperature ?? 0.3;
  $('#pJson').checked = p.jsonMode !== false;
  $('#pExtra').value = p.extraBody || '';
  $('#testStatus').textContent = '';
}

function readProfile() {
  const p = current();
  if (!p) return;
  p.name = $('#pName').value.trim() || '未命名';
  p.baseUrl = $('#pBase').value.trim();
  p.apiKey = $('#pKey').value.trim();
  p.model = $('#pModel').value.trim();
  p.temperature = Number($('#pTemp').value || 0.3);
  p.jsonMode = $('#pJson').checked;
  p.extraBody = $('#pExtra').value.trim();
}

function addProfile(preset) {
  readProfile();
  const id = 'p' + Date.now().toString(36);
  s.profiles.push({ id, apiKey: '', ...(preset || { name: '自定义', baseUrl: '', model: '', temperature: 0.3, jsonMode: true, extraBody: '' }) });
  currentId = id;
  renderProfileList();
  showProfile();
}

function readGeneral() {
  s.targetLang = $('#targetLang').value;
  s.inputTargetLang = $('#inputTargetLang').value;
  s.inputTrigger = $('#inputTrigger').checked;
  s.batchSize = Math.max(1, Number($('#batchSize').value) || 8);
  s.maxCharsPerBatch = Math.max(200, Number($('#maxChars').value) || 2500);
  s.concurrency = Math.max(1, Number($('#concurrency').value) || 4);
  s.youtubeEnabled = $('#ytEnabled').checked;
  s.youtubeShowOriginal = $('#ytOrig').checked;
  s.babeldocUrl = $('#babeldocUrl').value.trim() || LT.DEFAULTS.babeldocUrl;
  s.systemPrompt = $('#systemPrompt').value.trim() === LT.BATCH_SYSTEM_PROMPT.trim() ? '' : $('#systemPrompt').value;
}

function status(el, text, ok) {
  el.textContent = text;
  el.className = 'status ' + (ok ? 'ok' : 'err');
}

(async () => {
  s = await LT.getSettings();
  currentId = s.activeProfileId;
  if (!current()) currentId = s.profiles[0].id;

  const langs = LT.LANGS.map(([c, l]) => [c, l]);
  fillSelect($('#targetLang'), langs, s.targetLang);
  fillSelect($('#inputTargetLang'), langs, s.inputTargetLang);
  $('#inputTrigger').checked = s.inputTrigger;
  $('#batchSize').value = s.batchSize;
  $('#maxChars').value = s.maxCharsPerBatch;
  $('#concurrency').value = s.concurrency;
  $('#ytEnabled').checked = s.youtubeEnabled;
  $('#ytOrig').checked = s.youtubeShowOriginal;
  $('#babeldocUrl').value = s.babeldocUrl;
  $('#systemPrompt').value = s.systemPrompt || LT.BATCH_SYSTEM_PROMPT;

  renderProfileList();
  showProfile();

  $('#profileSel').onchange = (e) => {
    readProfile();
    currentId = e.target.value;
    showProfile();
  };
  $('#pName').oninput = () => {
    readProfile();
    renderProfileList();
  };
  $('#addDeepseek').onclick = () => addProfile({ ...LT.PRESETS.deepseek });
  $('#addZhipu').onclick = () => addProfile({ ...LT.PRESETS.zhipu });
  $('#addCustom').onclick = () => addProfile(null);
  $('#del').onclick = () => {
    if (s.profiles.length <= 1) return status($('#testStatus'), '至少保留一个配置。', false);
    s.profiles = s.profiles.filter((p) => p.id !== currentId);
    currentId = s.profiles[0].id;
    renderProfileList();
    showProfile();
  };

  $('#test').onclick = async () => {
    readProfile();
    const el = $('#testStatus');
    el.className = 'status';
    el.textContent = '测试中…';
    const r = await chrome.runtime.sendMessage({ type: 'testProfile', profile: current() });
    if (r && r.ok) {
      status(el, `连接成功（${r.ms} ms）\n译文：${r.result}\n批量 JSON 格式：${r.batchOk ? '正常' : '解析失败，会自动改为逐段翻译（较慢），可尝试关闭 JSON 模式或换模型'}`, true);
    } else {
      status(el, '失败：' + (r ? r.error : '后台无响应'), false);
    }
  };

  $('#save').onclick = async () => {
    readProfile();
    readGeneral();
    if (s.systemPrompt && !s.systemPrompt.includes('translations')) {
      return status($('#saveStatus'), '提示词里需要说明返回 {"translations": [...]} 格式。', false);
    }
    s.activeProfileId = currentId;
    await chrome.storage.local.set(s);
    status($('#saveStatus'), '已保存，并设为当前配置：' + current().name, true);
  };
})();
