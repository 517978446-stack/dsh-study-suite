window.__ModuleLoader__.load({
  id: '@local/study-suite',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ---- 共享能力探测：三个面板共用一次 /health，失败即全部降级 ----
    const Capabilities = (function () {
      const ENDPOINT = 'http://127.0.0.1:8791';
      const UNKNOWN = { llm: false, asr: false, asrModelReady: false, imageOcr: false, pdfOcr: false, known: false, platform: '' };
      const state = { caps: UNKNOWN, listeners: new Set(), inflight: null, raw: null, at: 0 };

      function publish(next) {
        state.caps = next;
        state.listeners.forEach(function (fn) { fn(next); });
      }

      function parse(data) {
        const c = (data && data.capabilities) || {};
        return {
          llm: c.llm !== false,
          asr: c.asr !== false,
          asrModelReady: c.asrModelReady !== false,
          asrDraftModel: c.asrDraftModel || 'base.en',
          platform: (data && data.platform) || '',
          imageOcr: c.imageOcr !== false,
          // pdfOcr 只影响扫描件；文字版 PDF 靠 pypdf 就能读，所以别把它理解成“PDF 不可用”
          pdfOcr: c.pdfOcr !== false,
          // fastTranslate 缺省视为可用（老版本服务没有这个字段）
          fastTranslate: c.fastTranslate !== false,
          mtError: c.mtError || '',
          known: true,
        };
      }

      function refresh(force) {
        if (state.inflight) return state.inflight;
        // 15 秒内复用上次结果：切标签时不会重复打 /health
        if (!force && state.raw && Date.now() - state.at < 15000) {
          return Promise.resolve(state.raw);
        }
        const controller = new AbortController();
        const timer = setTimeout(function () { controller.abort(); }, 2500);
        state.inflight = fetch(ENDPOINT + '/health', { cache: 'no-store', signal: controller.signal })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            state.raw = data;
            state.at = Date.now();
            publish(parse(data));
            return data;
          })
          .catch(function () {
            state.raw = null;
            state.at = 0;
            publish(UNKNOWN);
            return null;
          })
          .finally(function () {
            clearTimeout(timer);
            state.inflight = null;
          });
        return state.inflight;
      }

      function useCapabilities() {
        const [caps, setCaps] = React.useState(state.caps);
        React.useEffect(function () {
          function onUpdate(next) { setCaps(next); }
          state.listeners.add(onUpdate);
          setCaps(state.caps);
          refresh();
          return function () { state.listeners.delete(onUpdate); };
        }, []);
        return caps;
      }

      return { refresh: refresh, useCapabilities: useCapabilities };
    })();

    // ---- 学习台模块（原 study-panel，作用域隔离避免与同传重名） ----
    const StudyModules = (function () {


    const STORAGE_KEY = 'dsh-study-panel/v5';
    const LEGACY_KEY = 'dsh-study-panel/v4';
    const DEFAULT_SEMESTER_START = '2026-09-28';

    const DEFAULT_LIST_URL = 'https://www.thecn.com/user';
    const ENGINE = 'http://127.0.0.1:8791';

    // 默认不带任何课程：用户的课表是个人数据，不能随插件分发给别人
    const DEFAULT_COURSES = [];

    const DEFAULT_LINKS = [
      { label: 'The CN 课程', url: 'https://www.thecn.com' },
      { label: '知网 CNKI', url: 'https://www.cnki.net' },
      { label: 'Google 学术', url: 'https://scholar.google.com' },
      { label: 'arXiv', url: 'https://arxiv.org' },
      { label: '剑桥词典', url: 'https://dictionary.cambridge.org' },
    ];

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      card: 'var(--dsw-alias-bg-layer-1)',
      base: 'var(--dsw-alias-bg-base)',
      accent: 'var(--dsw-alias-brand-primary)',
    };

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function uid() {
      return Math.random().toString(36).slice(2, 10);
    }

    function readStore(key) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        return null;
      }
    }

    function defaultCourses() {
      return DEFAULT_COURSES.map((item) => ({ id: uid(), name: item.name, url: item.url }));
    }

    function parseDay(iso) {
      const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return isNaN(d.getTime()) ? null : d;
    }

    function weekOf(startIso, when) {
      const start = parseDay(startIso);
      if (!start) return null;
      const day = 86400000;
      const diff = Math.floor((new Date(when.getFullYear(), when.getMonth(), when.getDate()) - start) / day);
      if (diff < 0) return null;
      const week = Math.floor(diff / 7) + 1;
      const weekStart = new Date(start.getTime() + (week - 1) * 7 * day);
      return { week: week, start: weekStart, end: new Date(weekStart.getTime() + 6 * day) };
    }

    function rangeOfWeek(startIso, n) {
      const start = parseDay(startIso);
      if (!start || !n) return null;
      const day = 86400000;
      const weekStart = new Date(start.getTime() + (n - 1) * 7 * day);
      return { start: weekStart, end: new Date(weekStart.getTime() + 6 * day) };
    }

    function shortDate(d) {
      return d ? (d.getMonth() + 1) + '/' + d.getDate() : '';
    }

    function load() {
      const saved = readStore(STORAGE_KEY);
      const legacy = saved ? null : readStore(LEGACY_KEY);
      const source = saved && typeof saved === 'object' ? saved : legacy && typeof legacy === 'object' ? legacy : null;
      const base = {
        listUrl: (source && source.courseUrl) || DEFAULT_LIST_URL,
        semesterStart: DEFAULT_SEMESTER_START,
        links: clone(DEFAULT_LINKS),
        courses: defaultCourses(),
        tasks: [],
        cards: [],
      };
      if (!source) return base;
      // 空数组是用户主动删光的结果，不能回退到默认课程，否则删掉的课会自己长回来
      const courses = Array.isArray(source.courses)
        ? source.courses
            .filter((item) => item && typeof item.name === 'string')
            .map((item) => ({ id: String(item.id || uid()), name: item.name, url: String(item.url || '') }))
        : base.courses;
      return {
        listUrl: typeof source.listUrl === 'string' && source.listUrl ? source.listUrl : base.listUrl,
        semesterStart: typeof source.semesterStart === 'string' && source.semesterStart
          ? source.semesterStart
          : base.semesterStart,
        links: Array.isArray(source.links) && source.links.length ? source.links : base.links,
        courses: courses.filter((item) => !/CET/i.test(item.name)),
        tasks: Array.isArray(source.tasks)
          ? source.tasks
              .filter((item) => item && typeof item.text === 'string')
              .map((item) => ({ id: String(item.id || item.text), text: item.text, done: !!item.done }))
          : [],
        cards: Array.isArray(source.cards)
          ? source.cards
              .filter((item) => item && typeof item.front === 'string')
              .map((item) => ({ id: String(item.id || item.front), front: item.front, back: String(item.back || '') }))
          : [],
      };
    }

    function save(state) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (err) {
        /* storage unavailable: the panel still works for this view */
      }
    }

    function pillStyle(filled) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 26,
        padding: '0 10px',
        borderRadius: 13,
        border: '1px solid ' + (filled ? C.accent : C.border),
        background: filled ? C.accent : C.base,
        color: filled ? readableOn(C.accent) : C.text,
        fontSize: 12,
        textDecoration: 'none',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      };
    }

    function Button(props) {
      const primary = props.primary;
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          disabled: props.disabled,
          title: props.title,
          style: {
            height: props.small ? 24 : 28,
            padding: props.small ? '0 8px' : '0 12px',
            borderRadius: 8,
            border: '1px solid ' + (primary ? C.accent : C.border),
            background: primary ? C.accent : 'transparent',
            color: primary ? readableOn(C.accent) : C.text,
            fontSize: props.small ? 11 : 12,
            fontWeight: 500,
            cursor: props.disabled ? 'default' : 'pointer',
            opacity: props.disabled ? 0.5 : 1,
            flex: '0 0 auto',
          },
        },
        props.children,
      );
    }

    function Field(props) {
      return h('input', {
        value: props.value,
        placeholder: props.placeholder,
        onChange: (event) => props.onChange(event.target.value),
        onKeyDown: props.onKeyDown,
        style: Object.assign(
          {
            flex: '1 1 auto',
            minWidth: 0,
            height: 28,
            padding: '0 10px',
            borderRadius: 8,
            border: '1px solid ' + C.border,
            background: C.base,
            color: C.text,
            fontSize: 13,
            outline: 'none',
          },
          props.style,
        ),
      });
    }

    function Card(props) {
      return h(
        'section',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            border: '1px solid ' + C.border,
            borderRadius: 12,
            background: C.card,
            padding: 16,
            gap: 12,
          },
        },
        h(
          'header',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('h2', { style: { margin: 0, fontSize: 13, fontWeight: 600, color: C.text } }, props.title),
          props.note ? h('span', { style: { fontSize: 12, color: C.muted } }, props.note) : null,
          h('span', { style: { flex: '1 1 auto' } }),
          props.action || null,
        ),
        props.children,
      );
    }



    function resolveCssColor(cssColor) {
      // 用真实元素把任意 CSS 颜色（含 var/color-mix/oklch）解析成 RGB
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;background:' + cssColor;
      document.body.appendChild(probe);
      const raw = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#000';
      ctx.fillStyle = raw;
      ctx.fillRect(0, 0, 1, 1);
      const data = ctx.getImageData(0, 0, 1, 1).data;
      if (data[3] < 128) return null;
      return [data[0], data[1], data[2]];
    }

    function readableOn(cssColor, fallback) {
      const rgb = resolveCssColor(cssColor);
      if (!rgb) return fallback || '#ffffff';
      const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      return lum < 140 ? '#ffffff' : '#111111';
    }

    function useColorScheme() {
      const [scheme, setScheme] = React.useState('dark');
      React.useEffect(function () {
        // 令牌可能是 hex / rgb() / color-mix() / oklch()：用 canvas 把任意 CSS 颜色解析成 RGB
        function resolve(raw) {
          if (!raw) return null;
          const canvas = document.createElement('canvas');
          canvas.width = 1;
          canvas.height = 1;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          ctx.fillStyle = '#000';
          ctx.fillStyle = raw;
          ctx.fillRect(0, 0, 1, 1);
          const data = ctx.getImageData(0, 0, 1, 1).data;
          return { r: data[0], g: data[1], b: data[2], a: data[3] / 255 };
        }

        function readScheme() {
          const probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;background:var(--dsw-alias-bg-base)';
          document.body.appendChild(probe);
          const raw = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const color = resolve(raw);
          if (color && color.a > 0.5) {
            const lum = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
            setScheme(lum < 128 ? 'dark' : 'light');
            return;
          }
          setScheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        }

        readScheme();
        const observer = new MutationObserver(readScheme);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        if (media && media.addEventListener) media.addEventListener('change', readScheme);
        return function () {
          observer.disconnect();
          if (media && media.removeEventListener) media.removeEventListener('change', readScheme);
        };
      }, []);
      return scheme;
    }

    function Checkbox(props) {
      const checked = !!props.checked;
      return h(
        'span',
        {
          role: 'checkbox',
          'aria-checked': checked,
          tabIndex: 0,
          onClick: () => props.onChange(!checked),
          onKeyDown: (event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              props.onChange(!checked);
            }
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            fontSize: 12,
            color: props.color || C.muted,
            userSelect: 'none',
            outline: 'none',
            flex: '0 0 auto',
          },
        },
        h(
          'span',
          {
            style: {
              width: 15,
              height: 15,
              borderRadius: 4,
              border: '1px solid ' + (checked ? C.accent : 'var(--dsw-alias-border-l2)'),
              background: checked ? C.accent : 'transparent',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: '0 0 auto',
              boxSizing: 'border-box',
            },
          },
          checked
            ? h(
                'svg',
                {
                  width: 10,
                  height: 10,
                  viewBox: '0 0 12 12',
                  fill: 'none',
                  stroke: readableOn(C.accent),
                  strokeWidth: 2,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                },
                h('path', { d: 'M2 6.2 4.8 9 10 3.4' }),
              )
            : null,
        ),
        props.label ? h('span', null, props.label) : null,
      );
    }
    function TimetablePanel() {
      const scheme = useColorScheme();
      const [timetable, setTimetable] = React.useState({ classes: [], loading: true, error: '' });

      async function loadTimetable() {
        try {
          const response = await fetch(ENGINE + '/timetable', { cache: 'no-store' });
          const data = await response.json();
          setTimetable({
            classes: data.classes || [],
            loading: false,
            error: data.error || '',
          });
          if (data.skipped) {
            setNotice('有 ' + data.skipped + ' 条课表格式不对，已忽略（重新添加即可）');
          }
        } catch (err) {
          setTimetable({ classes: [], loading: false, error: '读不到课表' });
        }
      }

      const [draft, setDraft] = React.useState({ day: '1', start: '08:00', course: '', room: '' })
      const [notice, setNotice] = React.useState('')

      React.useEffect(function () {
        loadTimetable();
      }, []);

      function editDraft(patch) {
        setDraft(function (prev) { return Object.assign({}, prev, patch) })
      }

      async function importScreenshot(file) {
        setNotice('正在识别截图…')
        setTimetable(function (prev) { return Object.assign({}, prev, { loading: true, error: '' }) })
        try {
          const buffer = await file.arrayBuffer()
          const resp = await fetch(ENGINE + '/timetable/import', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'x-filename': file.name || 'timetable.png' },
            body: buffer,
          })
          const data = await resp.json()
          if (!resp.ok || data.error) throw new Error(data.error || '识别失败')
          const currentResp = await fetch(ENGINE + '/timetable', { cache: 'no-store' })
          const current = await currentResp.json()
          const existing = current.classes || []
          const seen = {}
          existing.forEach(function (item) { seen[item.day + '|' + item.start + '|' + item.course] = true })
          const fresh = (data.classes || []).filter(function (item) {
            const key = item.day + '|' + item.start + '|' + item.course
            if (seen[key]) return false
            seen[key] = true
            return true
          })
          if (!fresh.length) {
            setTimetable({ classes: existing, loading: false, error: '' })
            setNotice('这些课已经在课表里了，没有重复添加')
            return
          }
          const merged = existing.concat(fresh)
          const saveResp = await fetch(ENGINE + '/timetable/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ classes: merged }),
          })
          const saved = await saveResp.json()
          if (!saveResp.ok || saved.error) throw new Error(saved.error || '保存失败')
          setTimetable({ classes: saved.classes || merged, loading: false, error: '' })
          if (saved.skipped) {
            setNotice('识别到 ' + fresh.length + ' 节，已加入；有 ' + saved.skipped + ' 条格式不对被跳过（' + (saved.skipReason || '') + '）')
          } else {
            setNotice('识别到 ' + fresh.length + ' 节课程，已加入课表')
          }
        } catch (err) {
          setTimetable(function (prev) {
            return Object.assign({}, prev, { loading: false, error: String((err && err.message) || err) })
          })
          setNotice('')
        }
      }

      async function submitManual() {
        const course = (draft.course || '').trim()
        if (!course) {
          setNotice('先写课程名')
          return
        }
        const day = Number(draft.day)
        if (!(day >= 1 && day <= 7)) {
          setNotice('星期填 1-7（周一=1）')
          return
        }
        try {
          const resp = await fetch(ENGINE + '/timetable/add', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ course: course, day: day, start: draft.start || '08:00', room: (draft.room || '').trim() }),
          })
          const data = await resp.json()
          if (!resp.ok || data.error) throw new Error(data.error || '添加失败')
          setTimetable({ classes: data.classes || [], loading: false, error: '' })
          editDraft({ course: '', room: '' })
          setNotice('已添加 ' + course)
        } catch (err) {
          setNotice(String((err && err.message) || err))
        }
      }

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflowY: 'auto',
            background: C.base,
            color: C.text,
            colorScheme: scheme,
            padding: '20px 28px 40px',
          },
        },
        h(
          'div',
          { style: { maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 } },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              type: 'file',
              accept: 'image/*',
              style: { display: 'none' },
              id: 'ss-timetable-upload',
              onChange: function (event) {
                const file = event.target.files && event.target.files[0]
                event.target.value = ''
                if (file) importScreenshot(file)
              },
            }),
            h(Button, {
              primary: true,
              onClick: function () {
                const input = document.getElementById('ss-timetable-upload')
                if (input) input.click()
              },
            }, timetable.loading ? '识别中…' : '上传截图识别'),
            h('span', { style: { fontSize: 12, color: C.muted } }, '课表截图或拍照都行，识别后自动加入'),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            h(Field, {
              value: draft.course,
              placeholder: '课程名',
              style: { flex: '2 1 200px' },
              onChange: function (value) { editDraft({ course: value }) },
            }),
            h(Field, {
              value: draft.day,
              placeholder: '星期 1-7',
              style: { flex: '0 0 86px' },
              onChange: function (value) { editDraft({ day: value }) },
            }),
            h(Field, {
              value: draft.start,
              placeholder: '08:00',
              style: { flex: '0 0 82px' },
              onChange: function (value) { editDraft({ start: value }) },
            }),
            h(Field, {
              value: draft.room,
              placeholder: '教室',
              style: { flex: '1 1 110px' },
              onChange: function (value) { editDraft({ room: value }) },
              onKeyDown: function (event) {
                if (event.key === 'Enter') submitManual()
              },
            }),
            h(Button, { onClick: submitManual }, '添加'),
          ),
          notice
            ? h('div', { style: { fontSize: 12, color: C.muted } }, notice)
            : null,
          h(
            Card,
            {
              title: '本周课表',
              note: (function () {
                if (timetable.loading) return '读取中…';
                const today = new Date().getDay() === 0 ? 7 : new Date().getDay();
                const list = timetable.classes.filter(function (c) { return c.day === today; });
                const now = new Date().toTimeString().slice(0, 5);
                const sorted = list.slice().sort(function (a, b) { return a.start < b.start ? -1 : 1; });
                const next = sorted.filter(function (c) { return c.start >= now; })[0];
                if (!list.length) return '今天没课';
                return '今天 ' + list.length + ' 节' + (next ? ' · 下一节 ' + next.start + ' ' + next.course : ' · 今天已上完');
              })(),
              action: h(Button, { onClick: loadTimetable }, '刷新'),
            },
            timetable.error
              ? h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, timetable.error)
              : !timetable.loading && !timetable.classes.length
                ? h('p', { style: { margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.7 } },
                    '课表还是空的：上面传一张课表截图，或者手动加一门。')
                : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  [1, 2, 3, 4, 5, 6, 7].map(function (day) {
                    const list = timetable.classes
                      .filter(function (c) { return c.day === day; })
                      .sort(function (a, b) { return a.start < b.start ? -1 : 1; });
                    if (!list.length) return null;
                    const today = new Date().getDay() === 0 ? 7 : new Date().getDay();
                    const isToday = day === today;
                    const names = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
                    return h(
                      'div',
                      {
                        key: day,
                        style: {
                          display: 'flex',
                          gap: 10,
                          alignItems: 'flex-start',
                          padding: '7px 10px',
                          borderRadius: 8,
                          border: '1px solid ' + (isToday ? 'var(--dsw-alias-brand-primary)' : C.border),
                          background: C.base,
                        },
                      },
                      h(
                        'span',
                        {
                          style: {
                            flex: '0 0 42px',
                            fontSize: 12,
                            fontWeight: isToday ? 700 : 500,
                            color: isToday ? C.text : C.muted,
                          },
                        },
                        names[day],
                      ),
                      h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 auto', minWidth: 0 } },
                        list.map(function (c, index) {
                          return h(
                            'div',
                            { key: index, style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                            h('span', { style: { fontSize: 12, color: C.muted, flex: '0 0 auto' } }, c.start),
                            h('span', { style: { fontSize: 13, fontWeight: 600 } }, c.course),
                            c.room
                              ? h('span', { style: { fontSize: 12, color: C.muted } }, '· ' + c.room)
                              : null,
                          );
                        }),
                      ),
                    );
                  }),
                ),
          ),
        ),
      );
    }

    function StudyPanel() {
      const scheme = useColorScheme();
      const [state, setState] = React.useState(load);
      const [digest, setDigest] = React.useState({ loading: true, courses: [], fetchedAt: '', error: '' });
      const [expanded, setExpanded] = React.useState({});
      const [plan, setPlan] = React.useState({ items: [], loading: true, error: '' });
      const [editingCourse, setEditingCourse] = React.useState({});
      const caps = Capabilities.useCapabilities();
      const [readingJobs, setReadingJobs] = React.useState({});
      const [panelModal, setPanelModal] = React.useState(null);
      const [checkTarget, setCheckTarget] = React.useState('');
      const checkFileRef = React.useRef(null);
      const lastCheckFileRef = React.useRef(null);
      const [cnTokenInput, setCnTokenInput] = React.useState('');
      const [cnBusy, setCnBusy] = React.useState(false);
      const [installCopied, setInstallCopied] = React.useState(false);

      // 装少了什么：直接在面板上说清楚，别让人去翻文档
      const missing = (function () {
        if (!caps.known) return [];
        const list = [];
        if (caps.fastTranslate === false) list.push('快速翻译');
        if (caps.imageOcr === false) list.push('图片识别');
        if (caps.pdfOcr === false) list.push('扫描件 OCR');
        if (caps.asr === false) list.push('语音转写');
        return list;
      })();
      const installCommand = caps.platform === 'macos'
        ? './install.sh --full'
        : 'powershell -ExecutionPolicy Bypass -File .\\install.ps1 -Full';

      function copyInstallCommand() {
        try {
          navigator.clipboard.writeText(installCommand);
          setInstallCopied(true);
          setTimeout(function () { setInstallCopied(false); }, 1600);
        } catch (err) {
          setInstallCopied(false);
        }
      }
      const modalTokenRef = React.useRef(0);

      function closeModal() {
        // 关闭时作废当前请求：否则结果回来会把面板重新打开
        modalTokenRef.current += 1;
        setPanelModal(null);
      }
      const [showDone, setShowDone] = React.useState(false);
      const [filters, setFilters] = React.useState({});
      const [showOtherTeachers, setShowOtherTeachers] = React.useState({});
      const [showAllPages, setShowAllPages] = React.useState({});
      const [refreshing, setRefreshing] = React.useState(false);
      const [hiddenCourses, setHiddenCourses] = React.useState([]);
      const [showHidden, setShowHidden] = React.useState(false);
      const [cnLoggedAt, setCnLoggedAt] = React.useState(function () {
        try {
          const raw = window.localStorage.getItem('dsh-study-cn-login');
          const at = raw ? Number(raw) : 0;
          return Date.now() - at < 7 * 86400000 ? at : 0;
        } catch (err) {
          return 0;
        }
      });
      const [updatedAt, setUpdatedAt] = React.useState('');
      const [planNotice, setPlanNotice] = React.useState('');
      const [openDesc, setOpenDesc] = React.useState({});
      const [descPairs, setDescPairs] = React.useState({});
      const planSeq = React.useRef(0);
      const [newItem, setNewItem] = React.useState({ course: '', title: '', due: '' });
      const [taskDraft, setTaskDraft] = React.useState('');
      const [newCourse, setNewCourse] = React.useState('');
      const [frontDraft, setFrontDraft] = React.useState('');
      const [backDraft, setBackDraft] = React.useState('');
      const [cardIndex, setCardIndex] = React.useState(0);
      const [revealed, setRevealed] = React.useState(false);

      React.useEffect(function () {
        save(state);
      }, [state]);

      const remaining = state.tasks.filter((item) => !item.done).length;
      const nowWeek = weekOf(state.semesterStart, new Date());

      function annotatePage(page) {
        const text = String(page);
        const match = text.match(/week\s*(\d{1,2})/i) || text.match(/第\s*(\d{1,2})\s*周/);
        if (!match) return { suffix: '', past: false };
        const n = Number(match[1]);
        const range = rangeOfWeek(state.semesterStart, n);
        if (!range) return { suffix: '', past: false };
        const past = nowWeek ? n < nowWeek.week : false;
        return { suffix: ' [' + shortDate(range.start) + '–' + shortDate(range.end) + ']', past: past };
      }
      const cards = state.cards;
      const active = cards.length ? cards[((cardIndex % cards.length) + cards.length) % cards.length] : null;
      const visibleCourses = state.courses.filter(function (c) {
        return showHidden || hiddenCourses.indexOf(c.name) === -1;
      });
      const linked = visibleCourses.filter((item) => item.url).length;

      async function loadDigest() {
        setDigest(function (prev) {
          return Object.assign({}, prev, { loading: true, error: '' });
        });
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30000);
          const response = await fetch(ENGINE + '/digest', { cache: 'no-store', signal: controller.signal });
          clearTimeout(timer);
          const data = await response.json();
          if (data.error && !(data.courses || []).length) throw new Error(data.error);
          const courses = data.courses || [];
          setDigest({ loading: false, courses: courses, fetchedAt: data.fetchedAt || '', error: '' });
          // CN 里读到的课程自动补进「我的课程」，用户不用手动一门门加
          if (courses.length) {
            setState(function (prev) {
              const known = (prev.courses || []).map(function (item) { return item.name; });
              const added = [];
              courses.forEach(function (course) {
                if (!course.name || known.indexOf(course.name) >= 0) return;
                if (hiddenCourses.indexOf(course.name) >= 0) return;
                added.push({
                  id: 'cn-' + (course.number || course.name),
                  name: course.name,
                  url: course.url || '',
                });
              });
              if (!added.length) return prev;
              return Object.assign({}, prev, { courses: added.concat(prev.courses || []) });
            });
          }
        } catch (err) {
          setDigest({ loading: false, courses: [], fetchedAt: '', error: friendlyError(err) });
        }
      }

      async function refreshDigest() {
        setDigest(function (prev) {
          return Object.assign({}, prev, { loading: true, error: '' });
        });
        try {
          const response = await fetch(ENGINE + '/digest/refresh', { method: 'POST' });
          const data = await response.json();
          if (!response.ok || data.error) throw new Error(data.error || '刷新失败');
          await loadDigest();
        } catch (err) {
          setDigest({ loading: false, courses: [], fetchedAt: '', error: '刷新失败：' + err.message });
        }
      }

      React.useEffect(function () {
        loadDigest();
        // 待办只来自本地：文件导入 + 手动添加，不再自动去 CN 拉
        loadPlan();
        fetch(ENGINE + '/hidden', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (data) { setHiddenCourses((data && data.names) || []); })
          .catch(function () { setHiddenCourses([]); });
        fetch(ENGINE + '/filters', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (data) { setFilters((data && data.filters) || {}); })
          .catch(function () { setFilters({}); });
      }, []);

      async function loadPlan(manual) {
        if (manual) setRefreshing(true);
        const seq = ++planSeq.current;
        try {
          const response = await fetch(ENGINE + '/plan?t=' + Date.now(), { cache: 'no-store' });
          const data = await response.json();
          if (seq !== planSeq.current) return;
          setPlan({ items: data.items || [], loading: false, error: '' });
          if (manual) setUpdatedAt(new Date().toTimeString().slice(0, 8));
        } catch (err) {
          if (seq !== planSeq.current) return;
          setPlan({ items: [], loading: false, error: '读不到课程待办' });
        } finally {
          if (manual) setTimeout(function () { setRefreshing(false); }, 600);
        }
      }

      const chipStyle = {
        height: 22,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid ' + C.border,
        background: 'transparent',
        color: C.muted,
        fontSize: 11,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
      };

      async function addPlanItem() {
        const title = (newItem.title || '').trim();
        if (!title) {
          setPlanNotice('先写待办内容');
          return;
        }
        try {
          const response = await fetch(ENGINE + '/plan/add', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              course: (newItem.course || '').trim(),
              title: title,
              due: (newItem.due || '').trim(),
            }),
          });
          const data = await response.json();
          if (!response.ok || data.error) throw new Error(data.error || '添加失败');
          setPlan({ items: data.items || [], loading: false, error: '' });
          setNewItem({ course: '', title: '', due: '' });
          setPlanNotice('已添加：' + title);
        } catch (err) {
          setPlanNotice(String((err && err.message) || err));
        }
      }

      async function loadDescPairs(id) {
        if (descPairs[id] && descPairs[id].loading !== true) return;
        setDescPairs(function (prev) {
          const next = Object.assign({}, prev);
          next[id] = { loading: true, pairs: [], error: '' };
          return next;
        });
        try {
          const response = await fetch(ENGINE + '/plan/desc', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: id }),
          });
          const data = await response.json();
          if (!response.ok || data.error) throw new Error(data.error || '生成对照失败');
          setDescPairs(function (prev) {
            const next = Object.assign({}, prev);
            next[id] = { loading: false, pairs: data.pairs || [], error: '' };
            return next;
          });
        } catch (err) {
          setDescPairs(function (prev) {
            const next = Object.assign({}, prev);
            next[id] = { loading: false, pairs: [], error: String((err && err.message) || err) };
            return next;
          });
        }
      }

      async function importPlanFile(file) {
        setPlanNotice('正在读文档…');
        try {
          const buffer = await file.arrayBuffer();
          const response = await fetch(ENGINE + '/plan/import', {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              'x-filename': file.name || 'plan.txt',
            },
            body: buffer,
          });
          const data = await response.json();
          if (!response.ok || data.error) throw new Error(data.error || '导入失败');
          setPlan({ items: data.items || [], loading: false, error: '' });
          const source = data.source === 'llm' ? '大模型' : '按关键词';
          setPlanNotice(
            '从文档里认出 ' + (data.count || 0) + ' 条，新加 ' + (data.added || 0) +
            ' 条（' + source + '提取）'
          );
        } catch (err) {
          setPlanNotice(String((err && err.message) || err));
        }
      }

      async function removePlanItem(id) {
        try {
          const response = await fetch(ENGINE + '/plan/remove', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: id }),
          });
          const data = await response.json();
          if (!response.ok || data.error) throw new Error(data.error || '删除失败');
          setPlan({ items: data.items || [], loading: false, error: '' });
          setPlanNotice('已删除');
        } catch (err) {
          setPlanNotice(String((err && err.message) || err));
        }
      }

      async function togglePlan(id, done) {
        setPlan(function (prev) {
          return Object.assign({}, prev, {
            items: prev.items.map(function (item) {
              return item.id === id ? Object.assign({}, item, { done: done }) : item;
            }),
          });
        });
        try {
          await fetch(ENGINE + '/plan/toggle', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: id, done: done }),
          });
        } catch (err) {
          /* 失败就下次刷新时纠正 */
        }
      }

      function toggleCourse(name) {
        setExpanded(function (prev) {
          const next = Object.assign({}, prev);
          next[name] = !next[name];
          return next;
        });
      }

      function patch(next) {
        setState((prev) => Object.assign({}, prev, next));
      }

      function updateCourse(id, changes) {
        patch({ courses: state.courses.map((item) => (item.id === id ? Object.assign({}, item, changes) : item)) });
      }

      function addCourse() {
        const name = newCourse.trim();
        if (!name) return;
        patch({ courses: state.courses.concat([{ id: uid(), name: name, url: '' }]) });
        setNewCourse('');
      }

      function removeCourse(id) {
        patch({ courses: state.courses.filter((item) => item.id !== id) });
      }

      function addTask() {
        const text = taskDraft.trim();
        if (!text) return;
        patch({ tasks: state.tasks.concat([{ id: uid(), text: text, done: false }]) });
        setTaskDraft('');
      }

      function toggleTask(id) {
        patch({
          tasks: state.tasks.map((item) => (item.id === id ? Object.assign({}, item, { done: !item.done }) : item)),
        });
      }

      function removeTask(id) {
        patch({ tasks: state.tasks.filter((item) => item.id !== id) });
      }

      function addCard() {
        const front = frontDraft.trim();
        if (!front) return;
        patch({ cards: cards.concat([{ id: uid(), front: front, back: backDraft.trim() }]) });
        setFrontDraft('');
        setBackDraft('');
        setCardIndex(cards.length);
        setRevealed(false);
      }

      function removeCard(id) {
        patch({ cards: cards.filter((item) => item.id !== id) });
        setCardIndex(0);
        setRevealed(false);
      }

      function stepCard(delta) {
        if (!cards.length) return;
        setCardIndex((prev) => prev + delta);
        setRevealed(false);
      }

      const courseRows = visibleCourses.map((item) => {
        const info = digest.courses.find(function (c) { return c.name === item.name; }) || null;
        const open = !!expanded[item.name];
        return h(
          'div',
          {
            key: item.id,
            style: {
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 8,
              border: '1px solid ' + C.border,
              background: C.base,
            },
          },
          h(
            'div',
            {
              onClick: function () { toggleCourse(item.name); },
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                cursor: info ? 'pointer' : 'default',
              },
            },
            h(
              'span',
              {
                style: {
                  color: info ? C.muted : 'transparent',
                  fontSize: 11,
                  width: 12,
                  flex: '0 0 auto',
                },
              },
              open ? '▾' : '▸',
            ),
            h(
              'span',
              {
                title: item.name,
                style: {
                  flex: '1 1 auto',
                  minWidth: 0,
                  fontSize: 13,
                  color: C.text,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              item.name,
            ),
            info
              ? h(
                  'span',
                  { style: { fontSize: 11, color: C.muted, flex: '0 0 auto' } },
                  (info.sections || []).length + ' 章 · ' + (info.page_count || 0) + ' 页' +
                    (info.announcements ? ' · ' + info.announcements + ' 公告' : ''),
                )
              : null,
            editingCourse[item.id]
              ? h(Field, {
                  value: item.url,
                  placeholder: '粘贴这门课的网址',
                  onChange: (value) => updateCourse(item.id, { url: value }),
                  style: { flex: '0 0 190px', height: 26, fontSize: 12 },
                })
              : null,
            h(
              'button',
              {
                type: 'button',
                onClick: (event) => {
                  event.stopPropagation();
                  setEditingCourse(function (prev) {
                    var next = Object.assign({}, prev);
                    next[item.id] = !next[item.id];
                    return next;
                  });
                },
                title: '修改这门课的网址',
                style: {
                  border: 'none',
                  background: 'transparent',
                  color: C.muted,
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: '0 4px',
                  flex: '0 0 auto',
                },
              },
              '✎',
            ),
            h(
              'a',
              {
                href: item.url || state.listUrl,
                target: '_blank',
                rel: 'noreferrer',
                onClick: (event) => event.stopPropagation(),
                style: Object.assign(pillStyle(!!item.url), { height: 26 }),
              },
              item.url ? '打开' : '去课程页',
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: (event) => {
                  event.stopPropagation();
                  removeCourse(item.id);
                },
                title: '从清单里移除',
                style: {
                  border: 'none',
                  background: 'transparent',
                  color: C.muted,
                  cursor: 'pointer',
                  fontSize: 14,
                  lineHeight: 1,
                  padding: 2,
                  flex: '0 0 auto',
                },
              },
              '×',
            ),
          ),
          open && info
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    padding: '4px 12px 10px 28px',
                    borderTop: '1px solid ' + C.border,
                    maxHeight: 320,
                    overflowY: 'auto',
                  },
                },
                (function () {
                  const filter = filters[item.name];
                  const sections = info.sections || [];
                  const isTeacherHeading = (title) => /^(Ms|Mrs|Mr|Dr|Prof)\b/i.test(title || '') || /^Nur\s/i.test(title || '');
                  const mine = filter
                    ? sections.filter(function (sec) {
                        const title = sec.title || '';
                        return !isTeacherHeading(title) || title.toLowerCase().indexOf(filter.teacher.toLowerCase()) >= 0;
                      })
                    : sections;
                  const others = filter
                    ? sections.filter(function (sec) {
                        const title = sec.title || '';
                        return isTeacherHeading(title) && title.toLowerCase().indexOf(filter.teacher.toLowerCase()) < 0;
                      })
                    : [];
                  const KEY = /(assess|assign|submission|submit|brief|rubric|project|quiz|exam|marks|outline|syllabus|announce|grade|requirement)/i;
                  const keepAll = !!showAllPages[item.name];
                  const showOthers = !!showOtherTeachers[item.name];
                  const source = showOthers ? sections : mine;
                  const prepared = source.map(function (sec) {
                    const pages = (sec.pages || []).slice();
                    if (showOthers || keepAll) {
                      return { section: sec, pages: pages.slice(0, 8), hidden: Math.max(0, pages.length - 8) };
                    }
                    const keep = pages.filter(function (page) {
                      return KEY.test(page) || KEY.test(sec.title || '');
                    });
                    return { section: sec, pages: keep.slice(0, 8), hidden: pages.length - Math.min(keep.length, 8) };
                  }).filter(function (entry) { return entry.pages.length > 0; });
                  const totalPages = source.reduce(function (sum, sec) { return sum + (sec.pages || []).length; }, 0);
                  const shownPages = prepared.reduce(function (sum, e) { return sum + e.pages.length; }, 0);
                  const hiddenTotal = Math.max(0, totalPages - shownPages);
                  const hiddenSections = Math.max(0, source.length - prepared.length);
                  const body = prepared.length === 0
                    ? h('span', { style: { fontSize: 12, color: C.muted } }, '这门课还没有作业相关的内容。')
                    : prepared.map(function (entry, index) {
                        const section = entry.section;
                        return h(
                          'div',
                          { key: index, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                          h('span', { style: { fontSize: 12, fontWeight: 600 } }, section.title || '(未命名章节)'),
                          entry.pages.map(function (page, pageIndex) {
                            const mark = annotatePage(page);
                            return h(
                              'span',
                              {
                                key: pageIndex,
                                style: {
                                  fontSize: 12,
                                  color: C.muted,
                                  paddingLeft: 10,
                                  opacity: mark.past ? 0.55 : 1,
                                },
                              },
                              '· ' + page + mark.suffix + (mark.past ? '（已过）' : ''),
                            );
                          }),
                        );
                      });
                  return h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    body,
                    h(
                      'div',
                      { style: { display: 'flex', gap: 10, alignItems: 'center', fontSize: 11, color: C.muted, flexWrap: 'wrap' } },
                      !keepAll && hiddenTotal > 0
                        ? h(
                            'button',
                            {
                              type: 'button',
                              onClick: function (event) {
                                event.stopPropagation();
                                setShowAllPages(function (prev) {
                                  var next = Object.assign({}, prev);
                                  next[item.name] = true;
                                  return next;
                                });
                              },
                              style: { border: 'none', background: 'transparent', color: C.accent, cursor: 'pointer', fontSize: 11, padding: 0 },
                            },
                            '只看作业（隐藏了 ' + hiddenTotal + ' 项 / ' + hiddenSections + ' 章教学材料） · 显示全部',
                          )
                        : keepAll
                          ? h(
                              'button',
                              {
                                type: 'button',
                                onClick: function (event) {
                                  event.stopPropagation();
                                  setShowAllPages(function (prev) {
                                    var next = Object.assign({}, prev);
                                    next[item.name] = false;
                                    return next;
                                  });
                                },
                                style: { border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 11, padding: 0 },
                              },
                              '只看作业相关',
                            )
                          : null,
                    ),
                    filter
                      ? h(
                          'div',
                          { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: C.muted } },
                          h('span', null, '只显示 ' + (filter.label || filter.teacher) + ' 的资料'),
                          others.length
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  onClick: function (event) {
                                    event.stopPropagation();
                                    setShowOtherTeachers(function (prev) {
                                      var next = Object.assign({}, prev);
                                      next[item.name] = !next[item.name];
                                      return next;
                                    });
                                  },
                                  style: {
                                    border: 'none',
                                    background: 'transparent',
                                    color: C.accent,
                                    cursor: 'pointer',
                                    fontSize: 11,
                                    padding: 0,
                                  },
                                },
                                showOtherTeachers[item.name]
                                  ? '只看我的老师'
                                  : '另有 ' + others.length + ' 位老师的资料',
                              )
                            : null,
                        )
                      : null,
                  );
                })(),
                h(
                  'a',
                  {
                    href: item.url || state.listUrl,
                    target: '_blank',
                    rel: 'noreferrer',
                    style: { fontSize: 11, color: C.muted, textDecoration: 'none' },
                  },
                  '在 CN 里打开这门课 →',
                ),
              )
            : null,
        );
      });

      const quickLinks = state.links.map((item) =>
        h(
          'a',
          { key: item.url, href: item.url, target: '_blank', rel: 'noreferrer', style: pillStyle(false) },
          item.label,
        ),
      );

      async function submitCnToken() {
        const token = cnTokenInput.trim();
        if (!token) return;
        setCnBusy(true);
        try {
          const response = await fetch(ENGINE + '/cn/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: token }),
          });
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || 'token 无效');
          setCnLoggedAt(Date.now());
          try { window.localStorage.setItem('dsh-study-cn-login', String(Date.now())); } catch (err) {}
          setCnTokenInput('');
          closeModal();
          await refreshDigest();
          await loadPlan();
        } catch (err) {
          setPanelModal(function (prev) {
            return Object.assign({}, prev, { error: err.message || '登录失败' });
          });
        } finally {
          setCnBusy(false);
        }
      }

      async function openBrief(item, path) {
        const token = ++modalTokenRef.current;
        setPanelModal({ type: 'brief', item: item, loading: true, data: null, error: '' });
        try {
          const response = await fetch(ENGINE + '/brief', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: path }),
          });
          const data = await response.json();
          if (token !== modalTokenRef.current) return;
          if (!response.ok) throw new Error(data.error || '提炼失败');
          setPanelModal({ type: 'brief', item: item, loading: false, data: data, error: '' });
        } catch (err) {
          if (token !== modalTokenRef.current) return;
          setPanelModal({ type: 'brief', item: item, loading: false, data: null, error: err.message });
        }
      }

      async function checkFile(file) {
        lastCheckFileRef.current = file || null;
        const token = ++modalTokenRef.current;
        const currentItem = panelModal && panelModal.item;
        setPanelModal({ type: 'check', item: currentItem, loading: true, data: null, error: '' });
        try {
          const buffer = await file.arrayBuffer();
          const response = await fetch(
            ENGINE + '/check' + (checkTarget ? '?targetWords=' + encodeURIComponent(checkTarget) : ''),
            {
              method: 'POST',
              headers: {
                'content-type': 'application/octet-stream',
                'x-filename': encodeURIComponent(file.name),
              },
              body: buffer,
            },
          );
          const data = await response.json();
          if (token !== modalTokenRef.current) return;
          if (!response.ok) throw new Error(data.error || '检查失败');
          setPanelModal({ type: 'check', item: currentItem, loading: false, data: data, error: '' });
        } catch (err) {
          if (token !== modalTokenRef.current) return;
          setPanelModal({ type: 'check', item: currentItem, loading: false, data: null, error: err.message });
        }
      }

      async function openCheck(item, path, target) {
        lastCheckFileRef.current = null;   // 改用附件时，别让「重新检查」又跑回上次上传的文件
        if (!path) {
          // 没有现成文档：直接开「选我的草稿」界面，
          // 之前这里照样去打 /check，弹窗里只会显示「缺少 path」
          setPanelModal({ type: 'check', item: item, loading: false, data: null, error: '', idle: true });
          return;
        }
        const token = ++modalTokenRef.current;
        setPanelModal({ type: 'check', item: item, loading: true, data: null, error: '' });
        try {
          const response = await fetch(ENGINE + '/check', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: path, targetWords: target ? [Number(target), null] : null }),
          });
          const data = await response.json();
          if (token !== modalTokenRef.current) return;
          if (!response.ok) throw new Error(data.error || '检查失败');
          setPanelModal({ type: 'check', item: item, loading: false, data: data, error: '' });
        } catch (err) {
          if (token !== modalTokenRef.current) return;
          setPanelModal({ type: 'check', item: item, loading: false, data: null, error: err.message });
        }
      }

      function renderModal() {
        if (!panelModal) return null;
        const data = panelModal.data || {};
        const body = [];
        if (panelModal.loading) {
          body.push(h('p', { key: 'l', style: { margin: 0, fontSize: 13, color: C.muted } },
            panelModal.type === 'brief' ? '正在读这份说明（首次约 10 秒）…' : '正在检查…'));
        } else if (panelModal.error && panelModal.type !== 'cnlogin') {
          body.push(h('p', { key: 'e', style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-state-error-primary)' } },
            panelModal.error));
        } else if (panelModal.type === 'cnlogin') {
          body.push(h('button', {
            key: 'oneclick',
            type: 'button',
            onClick: async function () {
              setPanelModal(function (p) { return Object.assign({}, p, { error: '' }) })
              try {
                const r = await fetch(ENGINE + '/cn/login', { method: 'POST' })
                const d = await r.json()
                if (d && d.ok) {
                  setCnLoggedAt(Date.now())
                  try { window.localStorage.setItem('dsh-study-cn-login', String(Date.now())) } catch (err) {}
                  closeModal()
                  await refreshDigest()
                  await loadPlan()
                } else {
                  setPanelModal(function (p) {
                    return Object.assign({}, p, { error: (d && d.error) || '一键登录失败' })
                  })
                }
              } catch (err) {
                setPanelModal(function (p) {
                  return Object.assign({}, p, { error: String((err && err.message) || err) })
                })
              }
            },
            style: Object.assign({}, pillStyle(false), {
              padding: '8px 14px', alignSelf: 'flex-start', fontWeight: 600,
            }),
          }, '一键登录（推荐）'))
          if (panelModal.error) {
            body.push(h('p', { key: 'err', style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } },
              panelModal.error));
          }
          body.push(h('p', { key: 's1', style: { margin: 0, fontSize: 13, lineHeight: 1.7 } },
            '1. 在浏览器里登录 CN（还没登录的话点下面这个链接）'));
          body.push(h('a', {
            key: 'link',
            href: 'https://www.thecn.com/',
            target: '_blank',
            rel: 'noreferrer',
            style: { fontSize: 12, color: C.accent, alignSelf: 'flex-start' },
          }, '打开 thecn.com（新标签页登录）'));
          body.push(h('p', { key: 's2', style: { margin: 0, fontSize: 13, lineHeight: 1.7 } },
            '2. 登录后按 F12 → Console，粘贴下面这行回车，token 会被复制'));
          body.push(h('code', {
            key: 'code',
            style: {
              fontSize: 12, padding: '8px 10px', borderRadius: 8,
              background: 'var(--dsw-alias-bg-base, #f2f3f5)',
              border: '1px solid ' + C.border, userSelect: 'all', wordBreak: 'break-all',
            },
          }, "copy(localStorage.getItem('cn_token'))"));
          body.push(h('p', { key: 's3', style: { margin: 0, fontSize: 13, lineHeight: 1.7 } },
            '3. 粘贴到下面，保存后课程和作业会自动读取（课表不抓取，用截图或手动添加）'));
          body.push(h('input', {
            key: 'token',
            value: cnTokenInput,
            onChange: (event) => setCnTokenInput(event.target.value.trim()),
            placeholder: '粘贴 token（约 32 位字母数字）',
            style: {
              height: 32, padding: '0 10px', fontSize: 12, borderRadius: 8,
              border: '1px solid ' + C.border, background: C.base, color: C.text, outline: 'none',
            },
          }));
          body.push(h('button', {
            key: 'save',
            type: 'button',
            disabled: cnBusy || !cnTokenInput.trim(),
            onClick: submitCnToken,
            style: Object.assign(pillStyle(true), { height: 30, alignSelf: 'flex-start', opacity: cnBusy || !cnTokenInput.trim() ? 0.6 : 1 }),
          }, cnBusy ? '验证中…' : '保存并登录'));
        } else if (panelModal.type === 'brief') {
          body.push(h('div', { key: 'w', style: { fontSize: 13 } }, h('b', null, '字数要求：'), data['字数要求'] || '未说明'));
          body.push(h('div', { key: 'f', style: { fontSize: 13 } }, h('b', null, '提交格式：'), data['提交格式'] || '未说明'));
          const need = data['必须包含'] || [];
          if (need.length) {
            body.push(h('div', { key: 'n', style: { fontSize: 13 } }, h('b', null, '必须包含：'),
              h('ul', { style: { margin: '4px 0 0', paddingLeft: 18 } },
                need.map((line, i) => h('li', { key: i, style: { fontSize: 12, lineHeight: 1.6 } }, line)))));
          }
          const rubric = data['评分点'] || [];
          if (rubric.length) {
            body.push(h('div', { key: 'r', style: { fontSize: 13 } }, h('b', null, '评分点：'),
              h('ul', { style: { margin: '4px 0 0', paddingLeft: 18 } },
                rubric.map(function (row, i) {
                  const name = (row && (row['项'] || row.criterion)) || '';
                  const weight = (row && (row['占比'] || row.weight)) || '';
                  return h('li', { key: i, style: { fontSize: 12, lineHeight: 1.6 } }, name + (weight ? ' · ' + weight : ''));
                }))));
          }
          const notes = data['注意事项'] || [];
          if (notes.length) {
            body.push(h('div', { key: 't', style: { fontSize: 13 } }, h('b', null, '注意：'),
              h('ul', { style: { margin: '4px 0 0', paddingLeft: 18 } },
                notes.map((line, i) => h('li', { key: i, style: { fontSize: 12, lineHeight: 1.6, color: C.muted } }, line)))));
          }
        } else {
          body.push(h('div', { key: 'u', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              type: 'file',
              accept: '.docx,.pdf,.txt',
              style: { display: 'none' },
              ref: function (node) { checkFileRef.current = node; },
              onChange: function (event) {
                const file = event.target.files && event.target.files[0];
                if (file) checkFile(file);
                event.target.value = '';
              },
            }),
            h('button', {
              type: 'button',
              onClick: function () { if (checkFileRef.current) checkFileRef.current.click(); },
              style: Object.assign(pillStyle(true), { height: 26, fontSize: 11 }),
            }, '选我的草稿检查'),
            h('span', { style: { fontSize: 11, color: C.muted } }, '选你的成稿（.docx / .pdf / .txt）')));
          if (panelModal.idle && !data.issues) {
            body.push(h('p', { key: 'hint', style: { margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.6 } },
              '选一份你的成稿（.docx / .pdf / .txt）开始检查。'));
            body.push(h('p', { key: 'hint2', style: { margin: 0, fontSize: 11, color: C.muted, lineHeight: 1.6 } },
              '下面「检查这份说明」查的是老师的要求原文，不是你的文章。'));
            body.push(h('button', {
              key: 'attached',
              type: 'button',
              onClick: function () {
                const doc = (panelModal.item && (panelModal.item.doc
                  || (panelModal.item.docs && panelModal.item.docs[0] && panelModal.item.docs[0].path))) || '';
                if (doc) openCheck(panelModal.item, doc, checkTarget);
              },
              style: Object.assign(pillStyle(false), { height: 26, fontSize: 11, alignSelf: 'flex-start' }),
            }, '检查这份说明'));
          }
          body.push(h('div', { key: 't', style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('span', { style: { fontSize: 12, color: C.muted } }, '目标字数'),
            h('input', {
              value: checkTarget,
              onChange: (event) => setCheckTarget(event.target.value.replace(/[^0-9]/g, '')),
              placeholder: '如 2000',
              style: {
                width: 90, height: 26, padding: '0 8px', fontSize: 12,
                border: '1px solid ' + C.border, borderRadius: 6,
                background: C.base, color: C.text, outline: 'none',
              },
            }),
            h('button', {
              type: 'button',
              onClick: function () {
                if (lastCheckFileRef.current) {
                  checkFile(lastCheckFileRef.current);
                } else {
                  const item = panelModal.item || {};
                  const doc = item.doc || (item.docs && item.docs[0] && item.docs[0].path) || '';
                  openCheck(item, doc, checkTarget);
                }
              },
              style: Object.assign(pillStyle(false), { height: 26, fontSize: 11 }),
            }, '重新检查')));
          body.push(h('ul', { key: 'i', style: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 } },
            (data.issues || []).map(function (row, i) {
              const color = row.level === 'ok' ? 'var(--dsw-alias-state-success-primary)'
                : row.level === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : C.muted;
              return h('li', { key: i, style: { fontSize: 12, lineHeight: 1.6, color: color } }, row.text);
            })));
          if (data.aiRate !== null && data.aiRate !== undefined) {
            body.push(h('div', { key: 'a', style: { fontSize: 12, color: C.muted } },
              'AI 写作风险 ' + data.aiRate + '%' + (data.aiBand ? '（' + data.aiBand + '）' : '')));
          }
        }
        return h('div', {
          style: {
            position: 'fixed', inset: 0,
            // 框外正常变暗（半透明遮罩），框内卡片是实色，能完全盖住下方内容
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
            padding: 16,
          },
          onClick: closeModal,
        },
          h('div', {
            onClick: (event) => event.stopPropagation(),
            style: {
              width: 'min(560px, 92vw)', maxHeight: '80vh', overflow: 'auto',
              // 卡片必须是实色：C.layer 不存在会让整个面板透明
              background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
              color: C.text,
              border: '1px solid ' + C.border,
              borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', gap: 10,
              boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
              h('span', { style: { fontSize: 15, fontWeight: 600 } },
                panelModal.type === 'brief'
                  ? '作业要点'
                  : panelModal.type === 'cnlogin'
                    ? '导入 CN 登录'
                    : '提交前检查'),
              h('span', { style: { fontSize: 12, color: C.muted, flex: '1 1 auto' } },
                (panelModal.item && panelModal.item.title) || ''),
              h('button', {
                type: 'button',
                onClick: closeModal,
                style: { border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 16 },
              }, '×')),
            body));
      }

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflowY: 'auto',
            background: C.base,
            color: C.text,
            colorScheme: scheme,
            padding: '24px 28px 40px',
          },
        },
        h(
          'div',
          { style: { maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-end', gap: 12 } },
            h('h1', { style: { margin: 0, fontSize: 20, fontWeight: 600 } }, '学习台'),
            h(
              'span',
              { style: { fontSize: 12, color: C.muted, paddingBottom: 3 } },
              visibleCourses.length +
                ' 门课 · 已填链接 ' +
                linked +
                ' · ' +
                (remaining > 0 ? '今日还剩 ' + remaining + ' 项' : '今日已清空'),
            ),
            h('span', { style: { flex: '1 1 auto' } }),
            h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted } },
              '开学',
              h('input', {
                type: 'date',
                value: state.semesterStart,
                onChange: (event) => patch({ semesterStart: event.target.value }),
                title: '改这里，全面板的周次会跟着重算',
                style: {
                  height: 26,
                  padding: '0 6px',
                  borderRadius: 8,
                  border: '1px solid ' + C.border,
                  background: C.base,
                  color: C.text,
                  fontSize: 12,
                  colorScheme: scheme,
                },
              }),
              nowWeek
                ? h('span', { style: { fontWeight: 600, color: C.text } }, '第 ' + nowWeek.week + ' 周')
                : null,
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: function () {
                  setCnTokenInput('');
                  modalTokenRef.current += 1;
                  setPanelModal({ type: 'cnlogin', item: null, loading: false, data: null, error: '', idle: true });
                },
                title: cnLoggedAt
                  ? '已登录 CN。点这里可以重新导入 token（失效时用）'
                  : '导入 CN 登录：课程和作业会自动读取',
                style: Object.assign(pillStyle(false), {
                  height: 28,
                  cursor: 'pointer',
                  color: cnLoggedAt ? C.accent : C.text,
                  borderColor: cnLoggedAt ? C.accent : C.border,
                }),
              },
              cnLoggedAt ? '✓ CN 已登录' : '登录 CN',
            ),
            cnLoggedAt
              ? h(
                  'button',
                  {
                    key: 'cnlogout',
                    type: 'button',
                    onClick: async function () {
                      try {
                        await fetch(ENGINE + '/cn/logout', { method: 'POST' })
                      } catch (err) {}
                      setCnLoggedAt(null)
                      setDigest({ loading: false, courses: [], fetchedAt: '', error: '' })
                      try {
                        window.localStorage.removeItem('dsh-study-cn-login')
                      } catch (err) {}
                    },
                    title: '退出 CN 登录：删掉本机保存的 token 与课程缓存',
                    style: Object.assign(pillStyle(false), {
                      height: 28,
                      cursor: 'pointer',
                      color: C.muted,
                    }),
                  },
                  '退出',
                )
              : null,
            h(
              'a',
              {
                href: state.listUrl,
                target: '_blank',
                rel: 'noreferrer',
                style: Object.assign(pillStyle(true), { height: 28 }),
              },
              '打开课程列表',
            ),
          ),
          missing.length
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    padding: '12px 14px',
                    borderRadius: 10,
                    border: '1px solid ' + C.border,
                    background: C.base,
                  },
                },
                h('div', { style: { fontSize: 13, fontWeight: 600 } },
                  '这台机器少装了几样：' + missing.join('、')),
                h('div', { style: { fontSize: 12, color: C.muted, lineHeight: 1.7 } },
                  '缺的只是对应那几项功能，其它照常能用。重跑一次安装脚本、加上全量参数就会补上（已经装好的不会重复下载）：'),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                  h('code', {
                    style: {
                      flex: '1 1 auto',
                      minWidth: 0,
                      padding: '6px 10px',
                      borderRadius: 8,
                      background: 'rgba(127,127,127,0.12)',
                      fontSize: 12,
                      userSelect: 'all',
                      wordBreak: 'break-all',
                    },
                  }, installCommand),
                  h(Button, { onClick: copyInstallCommand }, installCopied ? '已复制' : '复制命令'),
                ),
                h('div', { style: { fontSize: 12, color: C.muted } },
                  '装完服务会自动重启，刷新面板就行。' +
                  (caps.mtError ? '（' + String(caps.mtError).slice(0, 80) + '）' : '')),
              )
            : null,
          h(
            Card,
            {
              title: '我的课程',
              note: 'UCSI' + ' · 共 ' + visibleCourses.length + ' 门 · 点「打开」直达',
              action: hiddenCourses.length
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: function () { setShowHidden(!showHidden); },
                      style: {
                        border: 'none',
                        background: 'transparent',
                        color: C.muted,
                        cursor: 'pointer',
                        fontSize: 11,
                      },
                    },
                    showHidden
                      ? '收起已隐藏的 ' + hiddenCourses.length + ' 门'
                      : '已隐藏 ' + hiddenCourses.length + ' 门',
                  )
                : null,
            },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, courseRows),
            h(
              'div',
              { style: { display: 'flex', gap: 8 } },
              h(Field, {
                value: newCourse,
                placeholder: '加一门课，写课程名',
                onChange: setNewCourse,
                onKeyDown: (event) => {
                  if (event.key === 'Enter') addCourse();
                },
              }),
              h(Button, { onClick: addCourse, disabled: !newCourse.trim() }, '添加'),
            ),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } }, quickLinks),
          ),
          h(
            Card,
            {
              title: '课程待办',
              note: plan.loading
                ? '读取中…'
                : plan.items.filter(function (i) { return !i.done; }).length + ' 项未完成' +
                  (refreshing ? ' · 刷新中…' : updatedAt ? ' · 已更新 ' + updatedAt : ''),
              action: h(
                'div',
                { style: { display: 'flex', gap: 6 } },
                h(
                  Button,
                  {
                    onClick: function () {
                      setShowDone(!showDone);
                    },
                  },
                  showDone
                    ? '只看未完成'
                    : plan.items.some(function (i) { return i.done; })
                      ? '显示已完成（' + plan.items.filter(function (i) { return i.done; }).length + '）'
                      : '只看未完成',
                ),
                h(Button, {
                  primary: true,
                  onClick: function () {
                    const input = document.getElementById('ss-plan-upload');
                    if (input) input.click();
                  },
                }, '导入文档'),
                h(Button, { onClick: function () { loadPlan(true); } }, '刷新'),
              ),
            },
            plan.error
              ? h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, plan.error)
              : null,
            planNotice
              ? h('p', { style: { margin: 0, fontSize: 12, color: C.muted } }, planNotice)
              : null,
            h(
              'div',
              { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
              h(Field, {
                value: newItem.course,
                placeholder: '课程（可留空）',
                style: { flex: '0 1 150px' },
                onChange: function (value) {
                  setNewItem(function (prev) { return Object.assign({}, prev, { course: value }); });
                },
              }),
              h(Field, {
                value: newItem.title,
                placeholder: '自己的待办，写一句英文会自动配中文',
                style: { flex: '3 1 240px' },
                onChange: function (value) {
                  setNewItem(function (prev) { return Object.assign({}, prev, { title: value }); });
                },
                onKeyDown: function (event) {
                  if (event.key === 'Enter') addPlanItem();
                },
              }),
              h(Field, {
                value: newItem.due,
                placeholder: '截止 2026-11-02',
                style: { flex: '0 0 130px' },
                onChange: function (value) {
                  setNewItem(function (prev) { return Object.assign({}, prev, { due: value }); });
                },
              }),
              h(Button, { onClick: addPlanItem }, '添加待办'),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('input', {
                type: 'file',
                accept: '.txt,.md,.csv,.docx,.pdf,.png,.jpg,.jpeg,.webp',
                style: { display: 'none' },
                id: 'ss-plan-upload',
                onChange: function (event) {
                  const file = event.target.files && event.target.files[0];
                  event.target.value = '';
                  if (file) importPlanFile(file);
                },
              }),
              h('span', { style: { fontSize: 11, color: C.muted } },
                '导入：课程大纲 / 作业说明都行，txt、docx、pdf、图片'),
            ),
            plan.items.length === 0 && !plan.loading && !plan.error
              ? h('div', { style: { margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.7 } },
                  h('p', { style: { margin: 0 } }, '还没有待办。'),
                  h('p', { style: { margin: '4px 0 0' } },
                    '点右上角「导入文档」把作业说明导进来，或在下面手动加一条；课表里排了今天/明天的课也会出现在这里。'))
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  (function () {
                    const order = state.courses.map(function (c) {
                      const matched = (c.name || '').match(/([A-Z]{2,}\d{3,4})/);
                      return matched ? matched[1] : c.name;
                    });
                    const rank = function (course) {
                      const index = order.indexOf(course);
                      return index === -1 ? 99 : index;
                    };
                    return plan.items
                      .filter(function (i) { return showDone || !i.done; })
                      .sort(function (a, b) {
                        const byCourse = rank(a.course) - rank(b.course);
                        if (byCourse !== 0) return byCourse;
                        if (!a.due && !b.due) return 0;
                        if (!a.due) return 1;
                        if (!b.due) return -1;
                        return a.due < b.due ? -1 : 1;
                      });
                  })().map(function (item) {
                    const todayLocal = (function () {
                      const now = new Date();
                      return now.getFullYear() + '-' +
                        String(now.getMonth() + 1).padStart(2, '0') + '-' +
                        String(now.getDate()).padStart(2, '0');
                    })();
                    const overdue = item.due && !item.done && item.due < todayLocal;
                    return h(
                      'div',
                      {
                        key: item.id,
                        style: {
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 8,
                          padding: '5px 9px',
                          borderRadius: 8,
                          border: '1px solid ' + (overdue ? 'var(--dsw-alias-state-error-primary)' : C.border),
                          background: C.base,
                        },
                      },
                      h(Checkbox, { checked: !!item.done, onChange: function (v) { togglePlan(item.id, v); } }),
                      h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 auto', minWidth: 0 } },
                        h(
                          'div',
                          { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
                          h('span', { style: { fontSize: 11, color: C.muted } },
                            (item.course || '') +
                            (item.courseName ? ' ' + item.courseName : '') +
                            (item.courseZh ? '（' + item.courseZh + '）' : '')),
                          h(
                            'span',
                            {
                              style: {
                                fontSize: 13,
                                color: item.done ? C.muted : C.text,
                                textDecoration: item.done ? 'line-through' : 'none',
                                wordBreak: 'break-word',
                              },
                            },
                            item.title,
                            item.titleZh
                              ? h('span', { style: { color: C.muted, fontWeight: 400 } }, '（' + item.titleZh + '）')
                              : null,
                          ),
                        ),
                        item.note
                          ? h('span', { style: { fontSize: 11, color: C.muted } }, item.note)
                          : null,
                        h(
                          'div',
                          { style: { display: 'flex', gap: 6, paddingTop: 2, flexWrap: 'wrap' } },
                          item.desc
                            ? h('button', {
                                type: 'button',
                                onClick: function (event) {
                                  event.stopPropagation();
                                  const opening = !openDesc[item.id];
                                  setOpenDesc(function (prev) {
                                    const next = Object.assign({}, prev);
                                    next[item.id] = opening;
                                    return next;
                                  });
                                  if (opening) loadDescPairs(item.id);
                                },
                                style: chipStyle,
                              }, openDesc[item.id] ? '收起要点' : '要点')
                            : null,
                          h('button', {
                            type: 'button',
                            onClick: function (event) {
                              event.stopPropagation();
                              openCheck(item, item.doc || (item.docs && item.docs[0] && item.docs[0].path) || '', checkTarget);
                            },
                            style: chipStyle,
                          }, '检查'),
                          item.url
                            ? h('a', {
                                href: item.url,
                                target: '_blank',
                                rel: 'noreferrer',
                                onClick: function (event) { event.stopPropagation(); },
                                style: Object.assign({ textDecoration: 'none' }, chipStyle),
                              }, '打开课程')
                            : null,

                          item.kind === 'custom'
                            ? h('button', {
                                type: 'button',
                                onClick: function (event) {
                                  event.stopPropagation();
                                  removePlanItem(item.id);
                                },
                                style: chipStyle,
                              }, '删除')
                            : null,
                        ),
                        openDesc[item.id] && item.desc
                          ? h(
                              'div',
                              {
                                style: {
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 6,
                                  paddingTop: 4,
                                  fontSize: 12,
                                  lineHeight: 1.65,
                                  wordBreak: 'break-word',
                                },
                              },
                              (function () {
                                const job = descPairs[item.id] || {};
                                const pairs = job.pairs || [];
                                if (pairs.length) {
                                  return pairs.map(function (pair, index) {
                                    return h(
                                      'div',
                                      { key: index, style: { display: 'flex', flexDirection: 'column', gap: 1 } },
                                      h('div', { style: { color: C.muted } }, pair.src),
                                      pair.dst
                                        ? h('div', { style: { color: C.text } }, pair.dst)
                                        : null,
                                    );
                                  });
                                }
                                return [
                                  h('div', { key: 'en', style: { color: C.muted } }, item.desc),
                                  job.loading
                                    ? h('div', { key: 'l', style: { color: C.muted, fontSize: 11 } }, '正在生成中英对照…')
                                    : job.error
                                      ? h('div', { key: 'e', style: { color: C.muted, fontSize: 11 } }, job.error)
                                      : null,
                                ];
                              })(),
                            )
                          : null,
                        (item.doc || item.url)
                          ? h(
                              'div',
                              { style: { display: 'flex', gap: 6, paddingTop: 2, flexWrap: 'wrap' } },
                              (function () {
                                const list = item.docs && item.docs.length
                                  ? item.docs
                                  : (item.doc ? [{ lang: 'en', path: item.doc }] : []);
                                const enDoc = list.find(function (d) { return d.lang === 'en'; });
                                const sourceDoc = list.find(function (d) { return d.lang === 'source'; });
                                const readDoc = sourceDoc || enDoc;
                                const chips = [];
                                if (readDoc) {
                                  chips.push(
                                    (function () {
                                      const job = readingJobs[item.id] || {};
                                      const running = job.status === 'running';
                                      const done = job.status === 'done';
                                      return h(
                                        'button',
                                        {
                                          key: 'read',
                                          type: 'button',
                                          onClick: function (event) {
                                            event.stopPropagation();
                                            if (!running) {
                                              setReadingJobs(function (prev) {
                                                var next = Object.assign({}, prev);
                                                next[item.id] = { status: 'running', done: 0, total: 0 };
                                                return next;
                                              });
                                              startReadingJob(
                                                readDoc.path,
                                                function (patch) {
                                                  setReadingJobs(function (prev) {
                                                    var next = Object.assign({}, prev);
                                                    next[item.id] = patch;
                                                    return next;
                                                  });
                                                },
                                                function (url) {
                                                  window.open(url, '_blank', 'noopener');
                                                  setReadingJobs(function (prev) {
                                                    var next = Object.assign({}, prev);
                                                    next[item.id] = { status: 'done' };
                                                    return next;
                                                  });
                                                  setTimeout(function () {
                                                    setReadingJobs(function (prev) {
                                                      var next = Object.assign({}, prev);
                                                      delete next[item.id];
                                                      return next;
                                                    });
                                                  }, 1500);
                                                },
                                              );
                                            }
                                          },
                                          title: '生成中英对照 PDF（原文 + 逐段翻译），首次需要一点时间，进度会显示在这里',
                                          style: {
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 6,
                                            height: 22,
                                            padding: '0 9px',
                                            borderRadius: 11,
                                            border: '1px solid ' + C.accent,
                                            background: running ? 'transparent' : C.accent,
                                            color: running ? C.text : readableOn(C.accent),
                                            fontSize: 11,
                                            fontWeight: 600,
                                            cursor: running ? 'default' : 'pointer',
                                          },
                                        },
                                        running ? readingProgressBar(job.done, job.total, C.accent) : null,
                                        running
                                          ? '生成中 ' + (job.done || 0) + '/' + (job.total || '…')
                                          : done
                                            ? '已生成'
                                            : '中英对照',
                                      );
                                    })(),
                                  );
                                }
                                if (readDoc) {
                                  chips.push(
                                    h(
                                      'button',
                                      {
                                        key: 'brief',
                                        type: 'button',
                                        disabled: !caps.llm,
                                        onClick: function (event) {
                                          event.stopPropagation();
                                          if (!caps.llm) return;
                                          openBrief(item, readDoc.path);
                                        },
                                        title: caps.llm
                                          ? '用本地 7B 把这份英文说明提炼成中文要点（首次约 10 秒，之后走缓存）'
                                          : '要点需要本机 7B 模型，目前仅 macOS 可用；Windows 可用「中英对照」看原文与译文',
                                        style: {
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          height: 22,
                                          padding: '0 9px',
                                          borderRadius: 11,
                                          border: '1px solid ' + C.border,
                                          background: 'transparent',
                                          color: caps.llm ? C.text : C.muted,
                                          fontSize: 11,
                                          cursor: caps.llm ? 'pointer' : 'not-allowed',
                                          opacity: caps.llm ? 1 : 0.5,
                                        },
                                      },
                                      '要点',
                                    ),
                                  );
                                  chips.push(
                                    h(
                                      'button',
                                      {
                                        key: 'check',
                                        type: 'button',
                                        onClick: function (event) {
                                          event.stopPropagation();
                                          setCheckTarget('');
                                          // 不自动检查作业说明，先让用户选自己的成稿
                                          modalTokenRef.current += 1;
                                          lastCheckFileRef.current = null;
                                          setPanelModal({ type: 'check', item: item, loading: false, data: null, error: '', idle: true });
                                        },
                                        title: '提交前自查：字数、引用、参考文献、文件名、AI 风险',
                                        style: {
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          height: 22,
                                          padding: '0 9px',
                                          borderRadius: 11,
                                          border: '1px solid ' + C.border,
                                          background: 'transparent',
                                          color: C.text,
                                          fontSize: 11,
                                          cursor: 'pointer',
                                        },
                                      },
                                      '检查',
                                    ),
                                  );
                                }
                                if (sourceDoc) {
                                  chips.push(
                                    h(
                                      'a',
                                      {
                                        key: 'source',
                                        href: ENGINE + '/file?path=' + encodeURIComponent(sourceDoc.path),
                                        target: '_blank',
                                        rel: 'noreferrer',
                                        title: sourceDoc.path,
                                        style: {
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          height: 22,
                                          padding: '0 9px',
                                          borderRadius: 11,
                                          border: '1px solid ' + C.border,
                                          color: C.text,
                                          fontSize: 11,
                                          textDecoration: 'none',
                                        },
                                      },
                                      'CN原件',
                                    ),
                                  );
                                }
                                return chips;
                              })(),

                            )
                          : null,
                      ),
                      item.due
                        ? h(
                            'span',
                            {
                              style: {
                                fontSize: 11,
                                flex: '0 0 auto',
                                color: overdue ? 'var(--dsw-alias-state-error-primary)' : C.muted,
                              },
                            },
                            (overdue ? '逾期 ' : '截止 ') + item.due.slice(5),
                          )
                        : null,
                    );
                  }),
                ),
          ),
          h(
            'div',
            {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                gap: 16,
                alignItems: 'start',
              },
            },
            h(
              Card,
              { title: '今日任务', note: remaining + ' / ' + state.tasks.length },
              h(
                'div',
                { style: { display: 'flex', gap: 8 } },
                h(Field, {
                  value: taskDraft,
                  placeholder: '加一条今天要做的事，回车保存',
                  onChange: setTaskDraft,
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') addTask();
                  },
                }),
                h(Button, { onClick: addTask, primary: true }, '添加'),
              ),
              state.tasks.length === 0
                ? h('p', { style: { margin: 0, fontSize: 12, color: C.muted } }, '还没有任务。')
                : h(
                    'ul',
                    {
                      style: {
                        listStyle: 'none',
                        margin: 0,
                        padding: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      },
                    },
                    state.tasks.map((item) =>
                      h(
                        'li',
                        {
                          key: item.id,
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 8px',
                            borderRadius: 8,
                            border: '1px solid ' + C.border,
                            background: C.base,
                          },
                        },
                        h(Checkbox, { checked: item.done, onChange: () => toggleTask(item.id) }),
                        h(
                          'span',
                          {
                            style: {
                              flex: '1 1 auto',
                              fontSize: 13,
                              color: item.done ? C.muted : C.text,
                              textDecoration: item.done ? 'line-through' : 'none',
                              wordBreak: 'break-word',
                            },
                          },
                          item.text,
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            onClick: () => removeTask(item.id),
                            title: '删除',
                            style: {
                              border: 'none',
                              background: 'transparent',
                              color: C.muted,
                              cursor: 'pointer',
                              fontSize: 14,
                              lineHeight: 1,
                              padding: 2,
                            },
                          },
                          '×',
                        ),
                      ),
                    ),
                  ),
            ),
            h(
              Card,
              { title: '复习卡片', note: cards.length ? cards.length + ' 张' : '空' },
              active
                ? h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                        padding: 14,
                        borderRadius: 10,
                        border: '1px solid ' + C.border,
                        background: C.base,
                        minHeight: 96,
                      },
                    },
                    h('div', { style: { fontSize: 13, fontWeight: 600, wordBreak: 'break-word' } }, active.front),
                    revealed
                      ? h(
                          'div',
                          {
                            style: {
                              fontSize: 13,
                              color: C.text,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              paddingTop: 8,
                              borderTop: '1px dashed ' + C.border,
                            },
                          },
                          active.back || '（这张卡没有背面）',
                        )
                      : null,
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 4 } },
                      h(
                        Button,
                        { onClick: () => setRevealed(!revealed), primary: !revealed },
                        revealed ? '收起' : '看答案',
                      ),
                      h(Button, { onClick: () => stepCard(1) }, '下一个'),
                      h('span', { style: { flex: '1 1 auto' } }),
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: () => removeCard(active.id),
                          title: '删除这张卡',
                          style: {
                            border: 'none',
                            background: 'transparent',
                            color: C.muted,
                            cursor: 'pointer',
                            fontSize: 12,
                            padding: 2,
                          },
                        },
                        '删除',
                      ),
                    ),
                  )
                : h('p', { style: { margin: 0, fontSize: 12, color: C.muted } }, '还没有卡片。'),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 } },
                h(Field, { value: frontDraft, placeholder: '正面：问题 / 单词 / 概念', onChange: setFrontDraft }),
                h(Field, { value: backDraft, placeholder: '背面：答案 / 释义（可留空）', onChange: setBackDraft }),
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'flex-end' } },
                  h(Button, { onClick: addCard, disabled: !frontDraft.trim() }, '新增卡片'),
                ),
              ),
            ),
          ),
          renderModal(),
          h(
            'p',
            { style: { margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.6 } },
            '课程网址：在 CN 里点进某门课，把地址栏链接复制到对应行，回车即保存。任务和卡片存在本机浏览器，不同步到别的设备。',
          ),
        ),
      );
    }

    function StudyIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M3 5.6A1.6 1.6 0 0 1 4.6 4H10a2.4 2.4 0 0 1 2 1.1A2.4 2.4 0 0 1 14 4h5.4A1.6 1.6 0 0 1 21 5.6v10.9a1.6 1.6 0 0 1-1.6 1.6H14a2.4 2.4 0 0 0-2 1.1 2.4 2.4 0 0 0-2-1.1H4.6A1.6 1.6 0 0 1 3 16.5z',
        }),
        h('path', { d: 'M12 6.2v13' }),
      );
    }


      return { Panel: StudyPanel, Icon: StudyIcon, Timetable: TimetablePanel };
    })();

    // ---- 同传模块（原 interpreter） ----

    // ---- 中英对照 PDF：后台生成 + 进度（多个面板共用）----
    function readingProgressBar(done, total, color) {
      const pct = total ? Math.max(4, Math.min(100, Math.round((done / total) * 100))) : 6;
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            width: 54,
            height: 4,
            borderRadius: 2,
            background: 'rgba(127,127,127,0.25)',
            overflow: 'hidden',
            verticalAlign: 'middle',
          },
        },
        h('span', {
          style: {
            display: 'block',
            width: pct + '%',
            height: '100%',
            background: color || 'currentColor',
            transition: 'width 0.3s ease',
          },
        }),
      );
    }

    async function startReadingJob(path, onProgress, onDone) {
      const endpoint = 'http://127.0.0.1:8791';
      let prepared;
      try {
        const response = await fetch(
          endpoint + '/reading/prepare?path=' + encodeURIComponent(path),
          { cache: 'no-store' },
        );
        prepared = await response.json();
      } catch (err) {
        onProgress({ status: 'error', error: '生成失败' });
        return;
      }
      if (!prepared || prepared.error) {
        onProgress({ status: 'error', error: (prepared && prepared.error) || '生成失败' });
        return;
      }
      if (prepared.status === 'ready') {
        onDone(endpoint + prepared.pdf);
        return;
      }
      onProgress({ status: 'running', done: prepared.done || 0, total: prepared.total || 0 });
      let polls = 0;
      const tick = setInterval(async function () {
        polls += 1;
        if (polls > 400) {                 // 约 6 分钟，防止无限轮询
          clearInterval(tick);
          onProgress({ status: 'error', error: '生成超时，请重试或改用快速引擎' });
          return;
        }
        try {
          const response = await fetch(
            endpoint + '/reading/status?path=' + encodeURIComponent(path),
            { cache: 'no-store' },
          );
          const data = await response.json();
          if (data.status === 'ready') {
            clearInterval(tick);
            onDone(endpoint + prepared.pdf);
          } else if (data.status === 'error') {
            clearInterval(tick);
            onProgress({ status: 'error', error: data.error || '生成失败' });
          } else {
            onProgress({ status: 'running', done: data.done || 0, total: data.total || 0 });
          }
        } catch (err) {
          /* 网络抖动继续轮询 */
        }
      }, 900);
    }

    // ---- 同传引擎：常驻模块级，切走面板也继续录音与识别 ----
    const Live = (function () {
      const TARGET_RATE = 16000;
      const SPEECH_RMS = 0.012;   // 判定「有人在说话」的阈值
      const SILENCE_MS = 260;     // 说完后静音多久切一句
      const MIN_MS = 450;         // 太短的片段丢掉
      const MAX_MS = 2600;        // 一直不停顿就强制切
      const ENDPOINT = 'http://127.0.0.1:8791';

      const state = {
        running: false,
        stream: null,
        ctx: null,
        node: null,
        source: null,
        listeners: new Set(),
        history: [],
        pending: null,
        queue: [],
        busy: false,
        lastError: '',
        engine: 'fast',
        target: 'zh',
        draftModel: 'base.en',
        finalModel: '',          // 空 = 服务端默认 small.en；'medium.en' = 精准识别
        lastText: '',            // 上一句，作为下一句的语境提示
        startedAt: 0,
        paused: false,
        lastLevelAt: 0,
        partialAt: 0,
        partialBusy: false,
        partialText: '',
      };

      function emit(type, payload) {
        // 调试用事件时间线（无副作用，可在控制台查看）
        try {
          if (window.__liveLog) {
            window.__liveLog.push({
              type: type,
              at: state.startedAt ? Date.now() - state.startedAt : 0,
              value: type === 'level' ? Math.round(payload * 1000) / 1000 : undefined,
            });
          }
        } catch (err) { /* ignore */ }
        state.listeners.forEach(function (fn) {
          try { fn(type, payload); } catch (err) { /* 订阅方自己出错不该影响录音 */ }
        });
      }

      function downsample(input, fromRate) {
        if (fromRate === TARGET_RATE) return input;
        const ratio = fromRate / TARGET_RATE;
        const length = Math.floor(input.length / ratio);
        const output = new Float32Array(length);
        for (let i = 0; i < length; i++) {
          const start = Math.floor(i * ratio);
          const end = Math.min(input.length, Math.floor((i + 1) * ratio));
          let sum = 0;
          for (let k = start; k < end; k++) sum += input[k];
          output[i] = sum / Math.max(1, end - start);
        }
        return output;
      }

      function encodeWav(samples) {
        const buffer = new ArrayBuffer(44 + samples.length * 2);
        const view = new DataView(buffer);
        const write = function (offset, text) {
          for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
        };
        write(0, 'RIFF');
        view.setUint32(4, 36 + samples.length * 2, true);
        write(8, 'WAVEfmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, TARGET_RATE, true);
        view.setUint32(28, TARGET_RATE * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        write(36, 'data');
        view.setUint32(40, samples.length * 2, true);
        let offset = 44;
        for (let i = 0; i < samples.length; i++, offset += 2) {
          const clamped = Math.max(-1, Math.min(1, samples[i]));
          view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        }
        return new Blob([view], { type: 'audio/wav' });
      }

      function normalise(samples) {
        let peak = 0;
        for (let i = 0; i < samples.length; i++) {
          const value = Math.abs(samples[i]);
          if (value > peak) peak = value;
        }
        if (peak < 0.02 || peak > 0.95) return samples;
        const gain = 0.9 / peak;
        const out = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
        return out;
      }

      function rms(samples) {
        if (!samples.length) return 0;
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        return Math.sqrt(sum / samples.length);
      }

      async function handleSegment(samples) {
        const level = rms(samples);
        if (level < SPEECH_RMS * 0.7) return;
        const wav = encodeWav(normalise(samples));
        const id = 'live-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        state.partialText = '';
        state.pending = { id: id, at: Date.now() };
        emit('pending', state.pending);
        try {
          let asrUrl = ENDPOINT + '/asr?prompt=auto&vad=0';
          if (state.finalModel) asrUrl += '&model=' + encodeURIComponent(state.finalModel);
          if (state.lastText) asrUrl += '&context=' + encodeURIComponent(state.lastText.slice(-200));
          const asr = await fetch(asrUrl, {
            method: 'POST',
            headers: { 'content-type': 'audio/wav' },
            body: wav,
          });
          const asrData = await asr.json().catch(function () { return {}; });
          if (!asr.ok) throw new Error(asrData.error || '转写失败');
          const text = (asrData.text || '').trim();
          if (!text) {
            state.pending = null;
            emit('drop', null);
            return;
          }
          const translated = await fetch(ENDPOINT + '/translate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: text, to: state.target, beam: 2, engine: state.engine }),
          }).then(function (r) { return r.json(); });
          const item = {
            id: id,
            offset: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
            src: text,
            dst: (translated && translated.text) || '',
            segments: asrData.segments || [],
            speaker: ((asrData.segments || [])[0] || {}).speaker || '',
            speakers: asrData.speakers || 1,
            at: Date.now(),
          };
          state.lastText = text;
          state.history.unshift(item);
          state.history = state.history.slice(0, 200);
          state.pending = null;
          emit('segment', item);
        } catch (err) {
          state.lastError = String(err && err.message ? err.message : err);
          state.pending = null;
          emit('error', state.lastError);
        }
      }

      function onAudio(event) {
        if (!state.running || state.paused) return;
        const input = event.inputBuffer.getChannelData(0);
        const samples = downsample(input, state.ctx.sampleRate);
        const level = rms(samples);
        const now = Date.now();
        if (now - state.lastLevelAt > 120) {
          state.lastLevelAt = now;
          emit('level', level);
          emit('time', Math.round((now - state.startedAt) / 1000));
        }
        if (level >= SPEECH_RMS) {
          state.speaking = true;
          state.silenceMs = 0;
        } else if (state.speaking) {
          state.silenceMs += (samples.length / TARGET_RATE) * 1000;
        }
        if (state.speaking) {
          state.chunks.push(samples);
          state.chunkMs += (samples.length / TARGET_RATE) * 1000;
        }
        // 边说边出字：说话期间每 ~900ms 用当前缓冲做一次快速识别
        if (
          state.speaking &&
          state.chunkMs >= 700 &&
          now - state.partialAt > 900 &&
          !state.partialBusy &&
          state.chunks.length
        ) {
          state.partialAt = now;
          state.partialBusy = true;
          try {
            const total = state.chunks.reduce(function (n, chunk) { return n + chunk.length; }, 0);
            const merged = new Float32Array(total);
            let cursor = 0;
            state.chunks.forEach(function (chunk) { merged.set(chunk, cursor); cursor += chunk.length; });
            // 草稿只送最近 2 秒：越短越快，前面的词已经在屏幕上了
            const keep = Math.min(merged.length, TARGET_RATE * 2);
            const snapshot = merged.slice(merged.length - keep);
            fetch(ENDPOINT + '/asr?prompt=auto&vad=0&beam=1&model=' + encodeURIComponent(state.draftModel), {
              method: 'POST',
              headers: { 'content-type': 'audio/wav' },
              body: encodeWav(normalise(snapshot)),
            })
              .then(function (response) { return response.json(); })
              .then(function (data) {
                const text = (data && data.text ? data.text : '').trim();
                if (text && text !== state.partialText) {
                  state.partialText = text;
                  emit('partial', text);
                }
              })
              .catch(function () { /* 草稿失败不影响正式那段 */ })
              .finally(function () { state.partialBusy = false; });
          } catch (err) {
            state.partialBusy = false;
          }
        }

        const long = state.chunkMs >= MAX_MS;
        const done = state.speaking && state.silenceMs >= SILENCE_MS && state.chunkMs >= MIN_MS;
        if (!done && !long) return;

        const total = state.chunks.reduce(function (n, chunk) { return n + chunk.length; }, 0);
        const merged = new Float32Array(total);
        let offset = 0;
        state.chunks.forEach(function (chunk) { merged.set(chunk, offset); offset += chunk.length; });
        state.chunks = [];
        state.chunkMs = 0;
        state.speaking = false;
        state.silenceMs = 0;
        if (merged.length / TARGET_RATE * 1000 >= MIN_MS) handleSegment(merged);
      }

      function warmup() {
        // 提前把语音模型和翻译引擎加载进内存，否则第一句要多等 4-6 秒
        try {
          const silence = encodeWav(new Float32Array(TARGET_RATE * 0.6));
          fetch(ENDPOINT + '/asr?vad=0', {
            method: 'POST',
            headers: { 'content-type': 'audio/wav' },
            body: silence,
          }).catch(function () { /* 预热失败不影响正式使用 */ });
          fetch(ENDPOINT + '/translate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'warmup sentence', to: state.target, beam: 1, engine: state.engine }),
          }).catch(function () { /* ignore */ });
        } catch (err) {
          /* ignore */
        }
      }

      async function start(options) {
        if (state.running) return;
        state.engine = (options && options.engine) || 'fast';
        state.target = (options && options.target) || 'zh';
        state.draftModel = (options && options.draftModel) || 'base.en';
        state.finalModel = (options && options.finalModel) || '';
        state.lastError = '';
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: Object.assign(
            { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            options && options.deviceId ? { deviceId: { exact: options.deviceId } } : {},
          ),
        });
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        const source = ctx.createMediaStreamSource(stream);
        const node = ctx.createScriptProcessor(4096, 1, 1);
        state.stream = stream;
        state.ctx = ctx;
        state.source = source;
        state.node = node;
        state.chunks = [];
        state.chunkMs = 0;
        state.speaking = false;
        state.silenceMs = 0;
        state.running = true;
        state.paused = false;
        state.startedAt = Date.now();
        warmup();
        node.onaudioprocess = onAudio;
        source.connect(node);
        node.connect(ctx.destination);
        emit('start', { at: Date.now() });
      }

      function pause() {
        state.paused = true;
        emit('paused', null);
      }

      function resume() {
        state.paused = false;
        emit('resumed', null);
      }

      function elapsed() {
        return state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
      }

      function stop() {
        if (!state.running && !state.node) return;
        state.running = false;
        try { state.node && state.node.disconnect(); } catch (err) { /* ignore */ }
        try { state.source && state.source.disconnect(); } catch (err) { /* ignore */ }
        try { state.ctx && state.ctx.close(); } catch (err) { /* ignore */ }
        if (state.stream) state.stream.getTracks().forEach(function (track) { track.stop(); });
        state.stream = null;
        state.ctx = null;
        state.source = null;
        state.node = null;
        state.chunks = [];
        state.chunkMs = 0;
        state.speaking = false;
        state.partialText = '';
        state.partialBusy = false;
        emit('stop', null);
      }

      function subscribe(fn) {
        state.listeners.add(fn);
        return function () { state.listeners.delete(fn); };
      }

      return {
        start: start,
        stop: stop,
        pause: pause,
        resume: resume,
        elapsed: elapsed,
        isPaused: function () { return state.paused; },
        subscribe: subscribe,
        isRunning: function () { return state.running; },
        history: function () { return state.history.slice(); },
        pending: function () { return state.pending; },
        lastError: function () { return state.lastError; },
      };
    })();

    const InterpreterModules = (function () {


    const ENGINE = 'http://127.0.0.1:8791';

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      card: 'var(--dsw-alias-bg-layer-1)',
      base: 'var(--dsw-alias-bg-base)',
      accent: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    };

    async function callEngine(path, payload, signal) {
      const response = await fetch(ENGINE + path, {
        method: payload ? 'POST' : 'GET',
        headers: payload ? { 'content-type': 'application/json' } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
        signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '本地引擎返回错误');
      return data;
    }

    function encodeWav(float32, sampleRate) {
      const samples = float32.length;
      const buffer = new ArrayBuffer(44 + samples * 2);
      const view = new DataView(buffer);
      const writeString = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
      };
      writeString(0, 'RIFF');
      view.setUint32(4, 36 + samples * 2, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(36, 'data');
      view.setUint32(40, samples * 2, true);
      let offset = 44;
      for (let i = 0; i < samples; i += 1) {
        const clamped = Math.max(-1, Math.min(1, float32[i]));
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        offset += 2;
      }
      return new Blob([view], { type: 'audio/wav' });
    }

    async function blobToWav(blob) {
      const arrayBuffer = await blob.arrayBuffer();
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const decoder = new AudioCtx();
      const decoded = await decoder.decodeAudioData(arrayBuffer);
      const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
      const offline = new OfflineAudioContext(1, frames, 16000);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      const rendered = await offline.startRendering();
      decoder.close();
      const data = rendered.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      return { blob: encodeWav(data, 16000), rms };
    }

    const SILENCE_RMS = 0.005;

    function pillStyle(active) {
      return {
        height: 26,
        padding: '0 12px',
        borderRadius: 13,
        border: '1px solid ' + (active ? C.accent : C.border),
        background: active ? C.accent : 'transparent',
        color: active ? readableOn(C.accent) : C.text,
        fontSize: 12,
        cursor: 'pointer',
        flex: '0 0 auto',
      };
    }

    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          disabled: props.disabled,
          style: {
            height: 28,
            padding: '0 14px',
            borderRadius: 8,
            border: '1px solid ' + (props.primary ? C.accent : C.border),
            background: props.primary ? C.accent : 'transparent',
            color: props.primary ? readableOn(C.accent) : C.text,
            fontSize: 12,
            fontWeight: 500,
            cursor: props.disabled ? 'default' : 'pointer',
            opacity: props.disabled ? 0.5 : 1,
            flex: '0 0 auto',
          },
        },
        props.children,
      );
    }

    function Card(props) {
      return h(
        'section',
        {
          style: {
            border: '1px solid ' + C.border,
            borderRadius: 12,
            background: C.card,
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          },
        },
        h(
          'header',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('h2', { style: { margin: 0, fontSize: 13, fontWeight: 600 } }, props.title),
          props.note ? h('span', { style: { fontSize: 12, color: C.muted } }, props.note) : null,
          h('span', { style: { flex: '1 1 auto' } }),
          props.action || null,
        ),
        props.children,
      );
    }



    function resolveCssColor(cssColor) {
      // 用真实元素把任意 CSS 颜色（含 var/color-mix/oklch）解析成 RGB
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;background:' + cssColor;
      document.body.appendChild(probe);
      const raw = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#000';
      ctx.fillStyle = raw;
      ctx.fillRect(0, 0, 1, 1);
      const data = ctx.getImageData(0, 0, 1, 1).data;
      if (data[3] < 128) return null;
      return [data[0], data[1], data[2]];
    }

    function readableOn(cssColor, fallback) {
      const rgb = resolveCssColor(cssColor);
      if (!rgb) return fallback || '#ffffff';
      const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      return lum < 140 ? '#ffffff' : '#111111';
    }

    function useColorScheme() {
      const [scheme, setScheme] = React.useState('dark');
      React.useEffect(function () {
        // 令牌可能是 hex / rgb() / color-mix() / oklch()：用 canvas 把任意 CSS 颜色解析成 RGB
        function resolve(raw) {
          if (!raw) return null;
          const canvas = document.createElement('canvas');
          canvas.width = 1;
          canvas.height = 1;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          ctx.fillStyle = '#000';
          ctx.fillStyle = raw;
          ctx.fillRect(0, 0, 1, 1);
          const data = ctx.getImageData(0, 0, 1, 1).data;
          return { r: data[0], g: data[1], b: data[2], a: data[3] / 255 };
        }

        function readScheme() {
          const probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;background:var(--dsw-alias-bg-base)';
          document.body.appendChild(probe);
          const raw = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const color = resolve(raw);
          if (color && color.a > 0.5) {
            const lum = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
            setScheme(lum < 128 ? 'dark' : 'light');
            return;
          }
          setScheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        }

        readScheme();
        const observer = new MutationObserver(readScheme);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        if (media && media.addEventListener) media.addEventListener('change', readScheme);
        return function () {
          observer.disconnect();
          if (media && media.removeEventListener) media.removeEventListener('change', readScheme);
        };
      }, []);
      return scheme;
    }

    function Checkbox(props) {
      const checked = !!props.checked;
      return h(
        'span',
        {
          role: 'checkbox',
          'aria-checked': checked,
          tabIndex: 0,
          onClick: () => props.onChange(!checked),
          onKeyDown: (event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              props.onChange(!checked);
            }
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            fontSize: 12,
            color: props.color || C.muted,
            userSelect: 'none',
            outline: 'none',
            flex: '0 0 auto',
          },
        },
        h(
          'span',
          {
            style: {
              width: 15,
              height: 15,
              borderRadius: 4,
              border: '1px solid ' + (checked ? C.accent : 'var(--dsw-alias-border-l2)'),
              background: checked ? C.accent : 'transparent',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: '0 0 auto',
              boxSizing: 'border-box',
            },
          },
          checked
            ? h(
                'svg',
                {
                  width: 10,
                  height: 10,
                  viewBox: '0 0 12 12',
                  fill: 'none',
                  stroke: readableOn(C.accent),
                  strokeWidth: 2,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                },
                h('path', { d: 'M2 6.2 4.8 9 10 3.4' }),
              )
            : null,
        ),
        props.label ? h('span', null, props.label) : null,
      );
    }
    function Interpreter() {
      const scheme = useColorScheme();
      const [status, setStatus] = React.useState('checking');
      const [termCount, setTermCount] = React.useState(0);
      const [mem, setMem] = React.useState({ llm: false, asr: false });
      const [nonce, setNonce] = React.useState(0);
      const [tab, setTab] = React.useState('doc');
      const [to, setTo] = React.useState('zh');
      const [engine, setEngine] = React.useState('llm');
      const caps = Capabilities.useCapabilities();
      const [docText, setDocText] = React.useState('');
      const [docResult, setDocResult] = React.useState('');
      const [docProgress, setDocProgress] = React.useState(null);   // {done,total}
      const [docFile, setDocFile] = React.useState(null);           // {name,chars}
      const [docFileBusy, setDocFileBusy] = React.useState(false);
      const docFileRef = React.useRef(null);
      const [docPairs, setDocPairs] = React.useState([]);
      const [docMs, setDocMs] = React.useState(0);
      const [verify, setVerify] = React.useState(true);
      const [sim, setSim] = React.useState(null);
      const [back, setBack] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [line, setLine] = React.useState('');
      const [history, setHistory] = React.useState([]);
      const [copied, setCopied] = React.useState('');
      const [mic, setMic] = React.useState('idle');
      const [subs, setSubs] = React.useState([]);
      const [minutes, setMinutes] = React.useState(null);
      const [devices, setDevices] = React.useState([]);
      const [deviceId, setDeviceId] = React.useState('');
      const deviceRef = React.useRef('');
      deviceRef.current = deviceId;
      const liveSegmentsRef = React.useRef([]);
      const streamRef = React.useRef(null);
      const liveRef = React.useRef(false);
      const toRef = React.useRef(to);
      toRef.current = to;

      const [pending, setPending] = React.useState(null);
      const [partialText, setPartialText] = React.useState('');
      const [liveEngine, setLiveEngine] = React.useState('fast');
      const [liveAccuracy, setLiveAccuracy] = React.useState('standard');
      const [levels, setLevels] = React.useState([]);
      const [elapsed, setElapsed] = React.useState(0);
      const [summary, setSummary] = React.useState([]);
      const [summaryBusy, setSummaryBusy] = React.useState(false);
      const subsRef = React.useRef(subs);
      const lastSummaryRef = React.useRef(0);
      subsRef.current = subs;

      // 订阅常驻引擎：面板卸载只退订，不打断录音（切去别的标签/面板仍在同传）
      React.useEffect(
        function () {
          const unsubscribe = Live.subscribe(function (type, payload) {
            if (type === 'start') {
              setMic('live');
              setStatus('online');
            } else if (type === 'stop') {
              setMic('idle');
              setPending(null);
            } else if (type === 'pending') {
              setPending(payload);
              setPartialText('');
            } else if (type === 'drop') {
              setPending(null);
              setPartialText('');
            } else if (type === 'segment') {
              setPending(null);
              if (Date.now() - lastSummaryRef.current > 15000) {
                lastSummaryRef.current = Date.now();
                setTimeout(function () { refreshSummary(); }, 0);
              }
              setSubs(function (prev) { return [payload].concat(prev).slice(0, 60); });
              liveSegmentsRef.current = liveSegmentsRef.current.concat(payload.segments || []);
              setStatus('online');
            } else if (type === 'error') {
              setPending(null);
              setError(payload);
            } else if (type === 'partial') {
              setPartialText(payload);
            } else if (type === 'level') {
              setLevels(function (prev) { return prev.concat([payload]).slice(-40); });
            } else if (type === 'time') {
              setElapsed(payload);
            }
          });
          // 面板重新打开时把已经识别的内容接回来
          const past = Live.history();
          if (past.length) setSubs(past.slice(0, 60));
          setMic(Live.isRunning() ? 'live' : 'idle');
          setPending(Live.pending());
          return unsubscribe;
        },
        [],
      );

      React.useEffect(
        function () {
          let alive = true;
          Capabilities.refresh()
            .then((data) => {
              if (!alive) return;
              if (!data) { setStatus('offline'); return; }
              setStatus('online');
              setTermCount((data.glossary && data.glossary.en_zh) || 0);
              const loaded = (data.idleUnload && data.idleUnload.loaded) || {};
              setMem({ llm: !!loaded.llm, asr: !!loaded.asr });
              const capability = data.capabilities || {};
              if (caps.known && capability.llm === false) {
                setEngine(function (current) { return current === 'llm' ? 'fast' : current; });
              }
            });
          return function () {
            alive = false;
          };
        },
        [nonce],
      );

      async function run(text, target, beam, wantVerify) {
        if (!text.trim()) return null;
        const data = await callEngine('/translate', {
          text: text,
          to: target,
          beam: beam || 2,
          verify: !!wantVerify,
          engine: caps.llm ? engine : 'fast',
        });
        return data;
      }

      async function refreshSummary() {
        const items = subsRef.current || [];
        if (!items.length) {
          setSummary([]);
          return;
        }
        setSummaryBusy(true);
        try {
          const segments = [];
          items.slice(0, 40).forEach(function (item) {
            (item.segments && item.segments.length ? item.segments : [{ text: item.src }]).forEach(function (seg) {
              segments.push(seg);
            });
          });
          const response = await fetch(ENGINE + '/summary', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ segments: segments }),
          });
          const data = await response.json().catch(function () { return {}; });
          setSummary(Array.isArray(data.bullets) ? data.bullets : []);
        } catch (err) {
          /* 总结失败不影响字幕 */
        } finally {
          setSummaryBusy(false);
        }
      }

      function splitDoc(text, limit) {
        // 按段落切，超长段落再按句子切，保证每段不超过 limit 字符
        const paras = text.split(/\n\s*\n/);
        const chunks = [];
        let buffer = '';
        paras.forEach(function (para) {
          if ((buffer + '\n\n' + para).length > limit && buffer) {
            chunks.push(buffer);
            buffer = para;
          } else {
            buffer = buffer ? buffer + '\n\n' + para : para;
          }
          while (buffer.length > limit) {
            const cut = buffer.lastIndexOf('. ', limit);
            const at = cut > limit * 0.5 ? cut + 1 : limit;
            chunks.push(buffer.slice(0, at));
            buffer = buffer.slice(at).trim();
          }
        });
        if (buffer.trim()) chunks.push(buffer);
        return chunks.filter(function (chunk) { return chunk.trim(); });
      }

      async function loadDocFile(file) {
        if (!file) return;
        setDocFileBusy(true);
        setError('');
        try {
          const buffer = await file.arrayBuffer();
          const response = await fetch(ENGINE + '/extract', {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              'x-filename': encodeURIComponent(file.name),
            },
            body: buffer,
          });
          const data = await response.json().catch(function () { return {}; });
          if (!response.ok) throw new Error(data.error || '读不出文件内容');
          setDocText(data.text || '');
          setDocFile({ name: file.name, chars: data.chars || (data.text || '').length });
          setDocResult('');
          setDocPairs([]);
          setSim(null);
          setBack('');
        } catch (err) {
          setError(err.message || '读取失败');
        } finally {
          setDocFileBusy(false);
        }
      }

      async function translateDoc() {
        setBusy(true);
        setError('');
        setDocProgress(null);
        try {
          const chunks = splitDoc(docText, 900);
          if (chunks.length <= 1) {
            const data = await run(docText, to, 4, verify);
            if (data) {
              setDocResult(data.text);
              setDocPairs(Array.isArray(data.pairs) ? data.pairs : []);
              setDocMs(data.ms);
              setSim(typeof data.similarity === 'number' ? data.similarity : null);
              setBack(data.back || '');
              setStatus('online');
            }
          } else {
            // 长文档逐段翻：能显示进度，也不会一个请求卡几分钟
            const started = Date.now();
            const texts = [];
            const pairs = [];
            for (let index = 0; index < chunks.length; index++) {
              setDocProgress({ done: index, total: chunks.length });
              const piece = await run(chunks[index], to, 4, false);
              if (piece) {
                texts.push(piece.text);
                (piece.pairs || []).forEach(function (pair) { pairs.push(pair); });
              }
            }
            setDocProgress({ done: chunks.length, total: chunks.length });
            setDocResult(texts.join('\n\n'));
            setDocPairs(pairs);
            setDocMs(Date.now() - started);
            setSim(null);
            setBack('');
            setStatus('online');
          }
        } catch (err) {
          setError(err.message);
          setStatus('offline');
        } finally {
          setBusy(false);
          setDocProgress(null);
        }
      }

      async function translateLine() {
        const text = line.trim();
        if (!text) return;
        setBusy(true);
        setError('');
        try {
          const data = await run(text, to, 2);
          if (data) {
            setHistory((prev) => [{ id: String(Date.now()), src: text, dst: data.text }].concat(prev).slice(0, 30));
            setLine('');
            setStatus('online');
          }
        } catch (err) {
          setError(err.message);
          setStatus('offline');
        } finally {
          setBusy(false);
        }
      }

      async function refreshDevices() {
        try {
          const list = await navigator.mediaDevices.enumerateDevices();
          setDevices(list.filter((item) => item.kind === 'audioinput'));
        } catch (err) {
          /* permission not granted yet */
        }
      }

      React.useEffect(function () {
        refreshDevices();
      }, []);

      async function ensureStream() {
        if (streamRef.current) return streamRef.current;
        const chosen = deviceRef.current;
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: Object.assign(
            {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
            },
            chosen ? { deviceId: { exact: chosen } } : {},
          ),
        });
        refreshDevices();
        streamRef.current = stream;
        return stream;
      }

      async function recordOnce(ms) {
        const stream = await ensureStream();
        const recorder = new MediaRecorder(stream);
        const chunks = [];
        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size) chunks.push(event.data);
        };
        const stopped = new Promise((resolve) => {
          recorder.onstop = resolve;
        });
        recorder.start();
        await new Promise((resolve) => setTimeout(resolve, ms));
        recorder.stop();
        await stopped;
        return new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      }

      async function processClip(blob) {
        const converted = await blobToWav(blob);
        if (converted.rms < SILENCE_RMS) return null;
        const response = await fetch(ENGINE + '/asr', {
          method: 'POST',
          headers: { 'content-type': 'audio/wav' },
          body: converted.blob,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '转写失败');
        const text = (data.text || '').trim();
        if (!text) return null;
        const translated = await callEngine('/translate', {
          text: text,
          to: toRef.current,
          beam: 2,
          engine: engine,
        });
        const segments = data.segments || [];
        const speakers = [];
        segments.forEach((item) => {
          const label = item.speaker;
          if (label && speakers.indexOf(label) < 0) speakers.push(label);
        });
        return {
          src: text,
          dst: translated.text,
          speaker: speakers.join(' / '),
          segments: segments,
          rms: converted.rms,
        };
      }

      async function buildMinutes(segments) {
        if (!segments || !segments.length) return;
        setMinutes({ loading: true });
        try {
          const response = await fetch(ENGINE + '/minutes', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ segments: segments }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || '纪要生成失败');
          setMinutes({ data: data.minutes, path: data.path });
        } catch (err) {
          setMinutes({ error: err.message });
        }
      }

      async function recordShot() {
        if (mic !== 'idle') return;
        setMic('shot');
        setError('');
        try {
          const blob = await recordOnce(8000);
          const pair = await processClip(blob);
          if (pair) {
            setSubs((prev) => [{ id: String(Date.now()), ...pair }].concat(prev).slice(0, 40));
            setStatus('online');
            buildMinutes(pair.segments);
          } else {
            setError('这一段没检测到有效语音（已按静音过滤）');
          }
        } catch (err) {
          setError(err.message);
        } finally {
          setMic('idle');
        }
      }

      React.useEffect(
        function () {
          if (mic !== 'live') return undefined;
          const timer = setInterval(function () { refreshSummary(); }, 15000);
          return function () { clearInterval(timer); };
        },
        [mic],
      );

      async function startLive() {
        if (Live.isRunning()) return;
        setError('');
        try {
          await Live.start({
            // 实时字幕优先延迟：7B 每句 2-3 秒，跟不上说话
            engine: liveEngine,
            draftModel: caps.asrDraftModel || 'base.en',
            // 精准识别用 medium.en：噪声下 WER 9.6%→6.5%，代价是每句多约 2.8 秒
            finalModel: liveAccuracy === 'high' ? 'medium.en' : '',
            target: toRef.current,
            deviceId: deviceRef.current || undefined,
          });
        } catch (err) {
          setError(err.message || '麦克风打不开');
          setMic('idle');
        }
      }

      function stopLive() {
        Live.stop();
        if (liveSegmentsRef.current.length) {
          buildMinutes(liveSegmentsRef.current);
          liveSegmentsRef.current = [];
        }
      }

      function copy(text, tag) {
        try {
          navigator.clipboard.writeText(text);
          setCopied(tag);
          setTimeout(() => setCopied(''), 1500);
        } catch (err) {
          /* clipboard blocked */
        }
      }

      const statusChip = h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted } },
        h('span', {
          style: {
            width: 7,
            height: 7,
            borderRadius: 4,
            background: status === 'online' ? C.ok : status === 'offline' ? C.warn : C.muted,
          },
        }),
        status === 'online' ? '引擎在线' : status === 'offline' ? '引擎未响应' : '检测中…',
      );

      const enginePills = h(
        'div',
        { style: { display: 'flex', gap: 6 } },
        h(
          'button',
          {
            type: 'button',
            onClick: () => { if (caps.fastTranslate !== false) setEngine('fast'); },
            disabled: caps.fastTranslate === false,
            title: caps.fastTranslate === false
              ? '这台机器没装快速翻译引擎（缺 ctranslate2 / sentencepiece），重装时加 -Full'
              : 'opus-mt，80–150ms，术语靠词表保证',
            style: Object.assign(pillStyle(engine === 'fast' || !caps.llm), {
              opacity: caps.fastTranslate === false ? 0.45 : 1,
              cursor: caps.fastTranslate === false ? 'not-allowed' : 'pointer',
            }),
          },
          '快速',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => { if (caps.llm) setEngine('llm'); },
            disabled: !caps.llm,
            title: caps.llm
              ? 'Qwen2.5-7B 本地大模型，2–5 秒，语境与格式更好'
              : '仅 macOS（Apple 芯片）可用：7B 依赖 MLX 推理框架，Windows/Linux 请用「快速」',
            style: Object.assign(pillStyle(engine === 'llm' && caps.llm), {
              opacity: caps.llm ? 1 : 0.45,
              cursor: caps.llm ? 'pointer' : 'not-allowed',
            }),
          },
          caps.llm ? '精准 7B' : '精准 7B（仅 macOS）',
        ),
      );

      const directionPills = h(
        'div',
        { style: { display: 'flex', gap: 6 } },
        h(
          'button',
          { type: 'button', onClick: () => setTo('zh'), style: pillStyle(to === 'zh') },
          '英 → 中',
        ),
        h(
          'button',
          { type: 'button', onClick: () => setTo('en'), style: pillStyle(to === 'en') },
          '中 → 英',
        ),
      );

      const docPane = h(
        Card,
        { title: '文档 / 论文翻译', note: '断网可用 · 选文件或整段粘贴' },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } },
          h('input', {
            ref: docFileRef,
            type: 'file',
            accept: '.txt,.md,.docx,.pdf',
            style: { display: 'none' },
            onChange: function (event) {
              const file = event.target.files && event.target.files[0];
              loadDocFile(file);
              event.target.value = '';
            },
          }),
          h(
            Button,
            { onClick: () => docFileRef.current && docFileRef.current.click(), disabled: docFileBusy },
            docFileBusy ? '读取中…' : '选择文件',
          ),
          h('span', { style: { fontSize: 11, color: C.muted } }, '支持 .docx / .pdf / .txt，也可直接拖进来'),
          docFile
            ? h(
                'span',
                { style: { fontSize: 11, color: C.ok } },
                '✓ ' + docFile.name + ' · ' + docFile.chars + ' 字',
              )
            : null,
        ),
        h('textarea', {
          value: docText,
          onChange: (event) => {
            setDocText(event.target.value);
            if (docFile) setDocFile(null);
          },
          onDragOver: (event) => event.preventDefault(),
          onDrop: (event) => {
            event.preventDefault();
            const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
            if (file) loadDocFile(file);
          },
          placeholder: to === 'zh' ? '粘贴英文原文（讲义、论文、作业要求…）' : '粘贴中文原文',
          spellCheck: false,
          style: {
            width: '100%',
            minHeight: 170,
            resize: 'none',
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid ' + C.border,
            background: C.base,
            color: C.text,
            fontSize: 13,
            lineHeight: 1.7,
            fontFamily: 'inherit',
            outline: 'none',
            boxSizing: 'border-box',
          },
        }),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h(Button, { onClick: translateDoc, primary: true, disabled: busy || !docText.trim() },
            busy
              ? (docProgress ? '翻译中… ' + docProgress.done + '/' + docProgress.total : '翻译中…')
              : '精翻'),
          docProgress
            ? readingProgressBar(docProgress.done, docProgress.total, C.accent)
            : null,
          h(Button, { onClick: () => { setDocText(''); setDocResult(''); setDocPairs([]); setError(''); setSim(null); setBack(''); } }, '清空'),
          h('span', { title: '译完后自动回译成原文语言，与原文比对，给出一致度评分' },
            h(Checkbox, { checked: verify, onChange: setVerify, label: '复核' }),
          ),
          h('span', { style: { flex: '1 1 auto' } }),
          docText.length > 1500 && engine === 'llm'
            ? h('span', { title: '精准模式逐段处理，长文档建议切「快速」引擎', style: { fontSize: 11, color: C.warn } },
                '长文档 + 精准模式较慢，可分 ' + splitDoc(docText, 900).length + ' 段处理')
            : null,
          docMs ? h('span', { style: { fontSize: 12, color: C.muted } }, docMs + ' ms') : null,
          sim !== null
            ? h(
                'span',
                {
                  title: back ? '回译结果：' + back : '',
                  style: {
                    fontSize: 12,
                    color: sim >= 0.75 ? C.ok : sim >= 0.55 ? C.warn : 'var(--dsw-alias-state-error-primary)',
                    cursor: 'help',
                  },
                },
                '还原度 ' + Math.round(sim * 100) + '%',
              )
            : null,
          docResult
            ? h(Button, { onClick: () => copy(docResult, 'doc') }, copied === 'doc' ? '已复制' : '复制译文')
            : null,
        ),
        docPairs.length
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  borderRadius: 8,
                  border: '1px solid ' + C.border,
                  background: C.base,
                  overflow: 'hidden',
                  maxHeight: 420,
                  overflowY: 'auto',
                },
              },
              docPairs.map(function (pair, index) {
                return h(
                  'div',
                  {
                    key: index,
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      padding: '9px 12px',
                      borderTop: index === 0 ? 'none' : '1px solid ' + C.border,
                    },
                  },
                  h(
                    'span',
                    {
                      style: {
                        fontSize: 12,
                        lineHeight: 1.6,
                        color: C.muted,
                        wordBreak: 'break-word',
                        userSelect: 'text',
                      },
                    },
                    pair.src,
                  ),
                  h(
                    'span',
                    {
                      style: {
                        fontSize: 13,
                        lineHeight: 1.8,
                        color: C.text,
                        wordBreak: 'break-word',
                        userSelect: 'text',
                      },
                    },
                    pair.dst,
                  ),
                );
              }),
            )
          : docResult
            ? h(
                'div',
                {
                  style: {
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid ' + C.border,
                    background: C.base,
                    fontSize: 13,
                    lineHeight: 1.8,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    userSelect: 'text',
                  },
                },
                docResult,
              )
            : null,
      );

      const dialogPane = h(
        Card,
        { title: '对话速译', note: '回车即译' },
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h('input', {
            value: line,
            onChange: (event) => setLine(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') translateLine();
            },
            placeholder: to === 'zh' ? '说/打一句英文' : '说/打一句中文',
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              height: 32,
              padding: '0 12px',
              borderRadius: 8,
              border: '1px solid ' + C.border,
              background: C.base,
              color: C.text,
              fontSize: 13,
              outline: 'none',
            },
          }),
          h(Button, { onClick: translateLine, primary: true, disabled: busy || !line.trim() }, '翻译'),
        ),
        history.length === 0
          ? h('p', { style: { margin: 0, fontSize: 12, color: C.muted } }, '还没有记录。')
          : h(
              'ul',
              { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 } },
              history.map((item) =>
                h(
                  'li',
                  {
                    key: item.id,
                    style: {
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid ' + C.border,
                      background: C.base,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    },
                  },
                  h('span', { style: { fontSize: 13, color: C.muted, wordBreak: 'break-word' } }, item.src),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
                    h('span', { style: { flex: '1 1 auto', fontSize: 13, fontWeight: 500, wordBreak: 'break-word' } }, item.dst),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => copy(item.dst, item.id),
                        style: {
                          border: 'none',
                          background: 'transparent',
                          color: C.muted,
                          cursor: 'pointer',
                          fontSize: 11,
                          padding: 2,
                          flex: '0 0 auto',
                        },
                      },
                      copied === item.id ? '已复制' : '复制',
                    ),
                  ),
                ),
              ),
            ),
      );

      const clock = function (seconds) {
        const total = Math.max(0, Math.round(seconds || 0));
        const m = Math.floor(total / 60);
        const sec = total % 60;
        return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
      };

      const linkBtn = {
        border: 'none',
        background: 'transparent',
        color: C.muted,
        cursor: 'pointer',
        fontSize: 11,
        padding: 0,
      };

      const renderSub = function (item) {
        return h(
          'div',
          {
            key: item.id,
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid ' + C.border,
              background: C.base,
            },
          },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            item.speaker
              ? h(
                  'span',
                  {
                    style: {
                      fontSize: 11,
                      padding: '1px 6px',
                      borderRadius: 6,
                      border: '1px solid ' + C.border,
                      color: C.muted,
                    },
                  },
                  item.speaker,
                )
              : null,
            h('span', { style: { fontSize: 11, color: C.muted } }, clock(item.offset)),
            h('span', { style: { flex: '1 1 auto' } }),
            h('button', { type: 'button', onClick: () => copy(item.dst, item.id), style: linkBtn },
              copied === item.id ? '已复制' : '复制'),
          ),
          h('span', { style: { fontSize: 13, color: C.muted, wordBreak: 'break-word' } }, item.src),
          h('span', { style: { fontSize: 14, fontWeight: 500, wordBreak: 'break-word' } }, item.dst),
        );
      };

      const voicePane = h(
        Card,
        {
          title: '同传工作台',
          note: caps.asr ? '说话即出字 · 切走标签也继续同传' : '未安装语音组件',
        },
        // 状态条：计时 + 波形 + 控制
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', {
            style: {
              width: 8,
              height: 8,
              borderRadius: 4,
              background: mic === 'live' ? (Live.isPaused() ? C.warn : C.ok) : C.border,
            },
          }),
          h('span', { style: { fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } },
            clock(mic === 'live' ? elapsed : 0)),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-end', gap: 2, height: 18, flex: '1 1 120px', minWidth: 80 } },
            (levels.length ? levels : new Array(24).fill(0)).slice(-40).map(function (value, index) {
              return h('span', {
                key: index,
                style: {
                  width: 3,
                  height: Math.max(2, Math.min(18, value * 260)),
                  background: C.accent,
                  borderRadius: 1,
                  opacity: value > 0.012 ? 0.85 : 0.25,
                },
              });
            }),
          ),
          mic === 'live'
            ? h(Button, { onClick: () => (Live.isPaused() ? Live.resume() : Live.pause()) },
                Live.isPaused() ? '继续' : '暂停')
            : h(Button, { onClick: startLive, primary: true, disabled: !caps.asr || mic === 'shot' }, '开始同传'),
          mic === 'live'
            ? h(Button, { onClick: stopLive, primary: true }, '停止')
            : h(
                'span',
                { style: { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 11, color: C.muted } },
                '引擎',
                h('button', { type: 'button', onClick: () => setLiveEngine('fast'),
                  style: Object.assign(pillStyle(liveEngine === 'fast'), { height: 24, fontSize: 11 }) }, '快速'),
                h('button', { type: 'button', onClick: () => setLiveEngine('llm'), disabled: !caps.llm,
                  style: Object.assign(pillStyle(liveEngine === 'llm'), { height: 24, fontSize: 11, opacity: caps.llm ? 1 : 0.4 }) }, '精准'),
              ),
          mic === 'live'
            ? null
            : h(
                'span',
                { style: { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 11, color: C.muted } },
                '识别',
                h('button', { type: 'button', onClick: () => setLiveAccuracy('standard'),
                  title: 'small.en：每句约 1.2 秒',
                  style: Object.assign(pillStyle(liveAccuracy === 'standard'), { height: 24, fontSize: 11 }) }, '标准'),
                h('button', { type: 'button', onClick: () => setLiveAccuracy('high'),
                  title: 'medium.en：噪声环境更准（WER 9.6%→6.5%），每句多约 2.4 秒；首次使用会下载约 1.5GB',
                  style: Object.assign(pillStyle(liveAccuracy === 'high'), { height: 24, fontSize: 11 }) }, '高精度'),
              ),
          h(Button, { onClick: recordShot, disabled: mic !== 'idle' || !caps.asr || Live.isRunning() }, '录一段'),
        ),
        !caps.asr
          ? h('p', { style: { margin: '8px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } },
              '未安装语音组件：Windows 请用 -Full 重装，或到 macOS 使用')
          : !caps.asrModelReady
            ? h('p', { style: { margin: '8px 0 0', fontSize: 12, color: C.muted } },
                '首次使用会下载语音模型（约 500MB），请保持联网')
            : null,
        error ? h('p', { style: { margin: '8px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        // 两栏：字幕流 + 实时总结
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr)',
              gap: 14,
              marginTop: 12,
              alignItems: 'start',
            },
          },
          h(
            'div',
            {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                maxHeight: 430,
                overflowY: 'auto',
                paddingRight: 4,
              },
            },
            pending
              ? h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      fontSize: 12,
                      color: C.muted,
                      padding: '6px 10px',
                      borderRadius: 8,
                      border: '1px dashed ' + C.border,
                    },
                  },
                  h('span', {
                    ref: function (node) {
                      if (!node || node.dataset.pulsing) return;
                      node.dataset.pulsing = '1';
                      if (typeof node.animate === 'function') {
                        node.animate([{ opacity: 0.25 }, { opacity: 1 }, { opacity: 0.25 }],
                          { duration: 1100, iterations: Infinity });
                      }
                    },
                    style: { width: 6, height: 6, borderRadius: 3, background: C.accent },
                  }),
                  h('span', null, partialText || '正在识别…'),
                )
              : null,
            subs.length
              ? subs.map(renderSub)
              : h('p', { style: { margin: 0, fontSize: 12, color: C.muted } },
                  mic === 'live' ? '在听了，开口说话就会出现字幕。' : '点「开始同传」，说话时这里会实时出中英字幕。'),
          ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' } },
              h('span', { style: { fontSize: 13, fontWeight: 600 } }, '实时总结'),
              h('button', { type: 'button', onClick: refreshSummary, style: linkBtn },
                summaryBusy ? '生成中…' : '刷新'),
            ),
            summary.length
              ? h(
                  'ul',
                  { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
                  summary.map(function (line, index) {
                    return h(
                      'li',
                      {
                        key: index,
                        style: {
                          fontSize: 12,
                          lineHeight: 1.6,
                          color: C.text,
                          paddingLeft: 10,
                          borderLeft: '2px solid ' + C.accent,
                        },
                      },
                      '· ' + line,
                    );
                  }),
                )
              : h('p', { style: { margin: 0, fontSize: 12, color: C.muted } },
                  summaryBusy ? '话题生成中…' : '开始同传后，这里会边听边总结要点。'),
            h(
              'button',
              {
                type: 'button',
                onClick: function () {
                  const all = [];
                  subs.forEach(function (item) { (item.segments || []).forEach(function (seg) { all.push(seg); }); });
                  buildMinutes(all);
                },
                disabled: !subs.length,
                style: Object.assign(pillStyle(false), { height: 26, marginTop: 4, opacity: subs.length ? 1 : 0.5 }),
              },
              '生成完整纪要',
            ),
          ),
        ),
      );

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflowY: 'auto',
            background: C.base,
            color: C.text,
            colorScheme: scheme,
            padding: '24px 28px 40px',
          },
        },
        h(
          'div',
          { style: { maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('h1', { style: { margin: 0, fontSize: 20, fontWeight: 600 } }, '离线同传'),
            statusChip,
            termCount
              ? h(
                  'span',
                  { style: { fontSize: 12, color: C.muted }, title: '术语表命中的词会强制按你的译法输出' },
                  '术语表 ' + termCount + ' 条',
                )
              : null,
            h('span', { style: { flex: '1 1 auto' } }),
            enginePills,
            directionPills,
            h(
              'button',
              {
                type: 'button',
                title: '立即卸载本机模型，把内存还给系统（下次使用会自动重新加载）',
                onClick: () => {
                  fetch(ENGINE + '/release', { method: 'POST' })
                    .catch(() => {})
                    .finally(() => setTimeout(() => setNonce((n) => n + 1), 400));
                },
                style: Object.assign(pillStyle(false), { height: 26 }),
              },
              mem.llm || mem.asr ? '释放内存（' + [mem.llm ? 'LLM' : '', mem.asr ? 'ASR' : ''].filter(Boolean).join('+') + '）' : '内存已空',
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  Capabilities.refresh(true);
                  setNonce((n) => n + 1);
                },
                style: Object.assign(pillStyle(false), { height: 26 }),
              },
              '重试连接',
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 6 } },
            h('button', { type: 'button', onClick: () => setTab('doc'), style: pillStyle(tab === 'doc') }, '文档'),
            h('button', { type: 'button', onClick: () => setTab('dialog'), style: pillStyle(tab === 'dialog') }, '对话'),
            h('button', { type: 'button', onClick: () => setTab('voice'), style: pillStyle(tab === 'voice') }, '语音'),
            h(
              'span',
              { style: { fontSize: 12, color: C.muted, alignSelf: 'center', marginLeft: 6 } },
              '全部离线 · 术语表 ' + termCount + ' 条',
            ),
          ),
          error
            ? h(
                'div',
                {
                  style: {
                    padding: '8px 12px',
                    borderRadius: 8,
                    border: '1px solid ' + C.warn,
                    color: C.text,
                    fontSize: 12,
                  },
                },
                error +
                  (caps.platform === 'windows'
                    ? '（先运行 %USERPROFILE%\\.dsh-study-suite\\run-service.cmd，或重跑 install.ps1）'
                    : '（macOS 可执行：launchctl kickstart -k gui/$(id -u)/com.local.cn-interpreter）'),
              )
            : null,
          tab === 'doc' ? docPane : tab === 'dialog' ? dialogPane : voicePane,
          h(
            'p',
            { style: { margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.6 } },
            engine === 'llm'
              ? '精准模式：本机 Qwen2.5-7B（4bit），首句约 2 秒加载。空闲 5 分钟自动卸载全部模型（含语音识别），内存还给系统。全部离线。'
              : '快速模式：opus-mt + 术语表，约 0.1 秒/句。空闲 10 分钟自动卸载。全部离线。',
          ),
        ),
      );
    }

    function InterpreterIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M4 5.5h9.5A1.5 1.5 0 0 1 15 7v5a1.5 1.5 0 0 1-1.5 1.5H9l-3.2 2.6v-2.6H4A1.5 1.5 0 0 1 2.5 12V7A1.5 1.5 0 0 1 4 5.5z' }),
        h('path', { d: 'M11 15.5h6.2L20.5 18v-2.5H21a1.5 1.5 0 0 0 1.5-1.5v-4.2A1.5 1.5 0 0 0 21 8.3h-2' }),
      );
    }


      return { Panel: Interpreter, Icon: InterpreterIcon };
    })();

    // ---- 外壳：一个图标、两个标签 ----
    const SHELL_C = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      base: 'var(--dsw-alias-bg-base)',
      accent: 'var(--dsw-alias-brand-primary)',
    };



    function useAppColorScheme() {
      const [scheme, setScheme] = React.useState('dark');
      React.useEffect(function () {
        function read() {
          const probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;background:var(--dsw-alias-bg-base)';
          document.body.appendChild(probe);
          const raw = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const canvas = document.createElement('canvas');
          canvas.width = 1;
          canvas.height = 1;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.fillStyle = '#000';
            ctx.fillStyle = raw;
            ctx.fillRect(0, 0, 1, 1);
            const d = ctx.getImageData(0, 0, 1, 1).data;
            if (d[3] > 128) {
              const lum = 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
              setScheme(lum < 140 ? 'dark' : 'light');
              return;
            }
          }
          setScheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        }
        read();
        const observer = new MutationObserver(read);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        return function () { observer.disconnect(); };
      }, []);
      return scheme;
    }

    // ---- AI 率检测模块 ----
    const DetectModules = (function () {
      const C = {
        text: 'var(--dsw-alias-label-primary)',
        muted: 'var(--dsw-alias-label-secondary)',
        border: 'var(--dsw-alias-border-l1)',
        card: 'var(--dsw-alias-bg-layer-1)',
        base: 'var(--dsw-alias-bg-base)',
        accent: 'var(--dsw-alias-brand-primary)',
        ok: 'var(--dsw-alias-state-success-primary)',
        warn: 'var(--dsw-alias-state-warn-primary)',
        bad: 'var(--dsw-alias-state-error-primary)',
      };

      function friendlyError(err) {
        const message = String(err && err.message ? err.message : err);
        if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
          return '连不上本地服务（127.0.0.1:8791）。先确认服务在跑：launchctl list | grep cn-interpreter，或重跑 install.sh';
        }
        if (/aborted|AbortError/i.test(message)) {
          return '请求超时了。文本长或模型刚在加载，稍等再试一次。';
        }
        return message;
      }

      function scoreColor(score) {
        return score >= 70 ? C.bad : score >= 45 ? C.warn : C.ok;
      }

      function DetectPanel() {
        const caps = Capabilities.useCapabilities();

        const scheme = useAppColorScheme();
        const [text, setText] = React.useState('');
        const [filename, setFilename] = React.useState('');
        const [pickedFile, setPickedFile] = React.useState('');
        const [result, setResult] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState('');
        const fileRef = React.useRef(null);

        async function detect() {
          setBusy(true);
          setError('');
          setResult(null);
          try {
            const file = fileRef.current && fileRef.current.files && fileRef.current.files[0];
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 180000);
            let response;
            if (file) {
              response = await fetch('http://127.0.0.1:8791/aidetect', {
                method: 'POST',
                headers: { 'x-filename': encodeURIComponent(file.name) },
                body: file,
                signal: controller.signal,
              });
            } else {
              response = await fetch('http://127.0.0.1:8791/aidetect', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text: text }),
                signal: controller.signal,
              });
            }
            clearTimeout(timer);
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.error) throw new Error(data.error || '检测失败');
            setResult(data);
            setFilename(data.filename || '');
          } catch (err) {
            setError(friendlyError(err));
          } finally {
            setBusy(false);
          }
        }

        const canRun = !busy && (pickedFile !== '' || text.trim().length >= 40);

        return h(
          'div',
          {
            style: {
              height: '100%',
              overflowY: 'auto',
              background: C.base,
              color: C.text,
              colorScheme: scheme,
              padding: '20px 28px 40px',
            },
          },
          h(
            'div',
            { style: { maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
              h('h1', { style: { margin: 0, fontSize: 20, fontWeight: 600 } }, 'AI 率检测'),
              h('span', { style: { fontSize: 12, color: C.muted } }, '本地启发式 · 支持 txt / docx / pdf / 图片'),
            ),
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  gap: 8,
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid ' + C.warn,
                  background: 'transparent',
                  fontSize: 12,
                  lineHeight: 1.7,
                  color: C.text,
                },
              },
              h('span', { style: { flex: '0 0 auto' } }, '⚠️'),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                h('span', { style: { fontWeight: 600 } }, '免责声明'),
                h(
                  'span',
                  { style: { color: C.muted } },
                  '本检测完全在本机用启发式指标估算，不是 Turnitin、GPTZero 等权威系统的判定结果。分数仅供你自查参考，不能作为学术不端的证据，也不能用来申诉或自证清白。不同工具对同一段文字的结论可能差异很大；请以学校官方检测为准。',
                ),
              ),
            ),
            h(
              'section',
              {
                style: {
                  border: '1px solid ' + C.border,
                  borderRadius: 12,
                  background: C.card,
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                },
              },
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('input', {
                  ref: fileRef,
                  type: 'file',
                  // 文字版 PDF 在 Windows 也能读；pdfOcr 只影响扫描件，所以 .pdf 始终可选
                  accept: caps.imageOcr ? '.txt,.md,.docx,.pdf,image/*' : '.txt,.md,.docx,.pdf',
                  onChange: function (event) {
                    const file = event.target.files && event.target.files[0];
                    setPickedFile(file ? file.name : '');
                    setFilename(file ? file.name : '');
                    setResult(null);
                  },
                  style: { fontSize: 12, color: C.text },
                }),
                h(
                  'span',
                  { style: { fontSize: 11, color: C.muted } },
                  pickedFile ? '已选文件，下方文本框会被忽略' : '选文件，或直接在下面粘贴文字',
                ),
              ),
              h('textarea', {
                value: text,
                onChange: function (event) { setText(event.target.value); },
                placeholder: '粘贴要检测的英文/中文文本（至少 40 字）',
                spellCheck: false,
                style: {
                  width: '100%',
                  minHeight: 150,
                  resize: 'none',
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid ' + C.border,
                  background: C.base,
                  color: C.text,
                  fontSize: 13,
                  lineHeight: 1.7,
                  fontFamily: 'inherit',
                  outline: 'none',
                  boxSizing: 'border-box',
                },
              }),
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: detect,
                    disabled: !canRun,
                    style: {
                      height: 30,
                      padding: '0 16px',
                      borderRadius: 8,
                      border: '1px solid ' + C.accent,
                      background: C.accent,
                      color: C.base,
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: busy ? 'default' : 'pointer',
                      opacity: canRun ? 1 : 0.5,
                    },
                  },
                  busy ? '检测中…' : '开始检测',
                ),
                filename ? h('span', { style: { fontSize: 12, color: C.muted } }, filename) : null,
              ),
            ),
            error
              ? h('div', { style: { fontSize: 12, color: C.bad } }, error)
              : null,
            result
              ? h(
                  'section',
                  {
                    style: {
                      border: '1px solid ' + C.border,
                      borderRadius: 12,
                      background: C.card,
                      padding: 16,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
                    h('span', { style: { fontSize: 34, fontWeight: 700, color: scoreColor(result.score) } }, result.score),
                    h('span', { style: { fontSize: 15, fontWeight: 600, color: scoreColor(result.score) } }, result.band),
                    h('span', { style: { flex: '1 1 auto', fontSize: 12, color: C.muted } }, result.chars + ' 字 · ' + result.sentences + ' 句 · ' + result.ms + ' ms'),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    Object.keys(result.components || {}).map(function (key) {
                      const item = result.components[key];
                      return h(
                        'div',
                        { key: key, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                        h(
                          'div',
                          { style: { display: 'flex', gap: 8, fontSize: 12 } },
                          h('span', { style: { flex: '1 1 auto', color: C.muted } }, item.label),
                          h('span', { style: { color: C.text } }, item.value),
                          h('span', { style: { width: 44, textAlign: 'right', color: scoreColor(item.aiHint * 100) } }, Math.round(item.aiHint * 100) + '%'),
                        ),
                        h(
                          'div',
                          { style: { height: 4, borderRadius: 2, background: C.border, overflow: 'hidden' } },
                          h('div', { style: { width: Math.round(item.aiHint * 100) + '%', height: '100%', background: scoreColor(item.aiHint * 100) } }),
                        ),
                      );
                    }),
                  ),
                  (result.suspects || []).length
                    ? h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                        h('span', { style: { fontSize: 12, fontWeight: 600, color: C.muted } }, '最像机器生成的片段'),
                        (result.suspects || []).map(function (item, index) {
                          return h(
                            'div',
                            {
                              key: index,
                              style: {
                                fontSize: 12,
                                color: C.text,
                                lineHeight: 1.6,
                                padding: '8px 10px',
                                borderRadius: 8,
                                border: '1px solid ' + C.border,
                                background: C.base,
                              },
                            },
                            h('span', { style: { color: C.muted } }, '困惑度 ' + item.ppl + '：'),
                            item.text,
                          );
                        }),
                      )
                    : null,
                  result.preview
                    ? h('div', {
                        style: {
                          fontSize: 12,
                          color: C.muted,
                          lineHeight: 1.6,
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid ' + C.border,
                          background: C.base,
                          maxHeight: 120,
                          overflow: 'hidden',
                        },
                      }, result.preview)
                    : null,
                  h('div', { style: { fontSize: 11, color: C.muted, lineHeight: 1.6 } }, result.caveat),
                )
              : null,
          ),
        );
      }

      return { Panel: DetectPanel };
    })();

    class PanelErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error };
      }
      render() {
        if (!this.state.error) {
          return this.props.children;
        }
        return React.createElement(
          'div',
          { style: { padding: '24px 28px', fontFamily: 'inherit' } },
          React.createElement('h2', { style: { margin: '0 0 8px', fontSize: 16 } }, '这个页面出错了'),
          React.createElement(
            'p',
            { style: { margin: '0 0 12px', fontSize: 13, color: '#6b7280' } },
            '换一个标签还能继续用。把下面这段发给开发者即可定位。',
          ),
          React.createElement(
            'pre',
            {
              style: {
                padding: '12px 14px',
                borderRadius: 8,
                background: 'rgba(127,127,127,0.10)',
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 240,
                overflow: 'auto',
              },
            },
            String((this.state.error && this.state.error.stack) || this.state.error),
          ),
        );
      }
    }

    function Suite() {
      const scheme = useAppColorScheme();
      const [tab, setTab] = React.useState('study');
      const [liveOn, setLiveOn] = React.useState(Live.isRunning());

      React.useEffect(function () {
        const unsubscribe = Live.subscribe(function (type) {
          if (type === 'start') setLiveOn(true);
          else if (type === 'stop') setLiveOn(false);
        });
        setLiveOn(Live.isRunning());
        return unsubscribe;
      }, []);

      function pill(active) {
        return {
          height: 28,
          padding: '0 14px',
          borderRadius: 14,
          border: '1px solid ' + (active ? SHELL_C.accent : SHELL_C.border),
          background: active ? SHELL_C.accent : 'transparent',
          color: active ? readableOnShell(SHELL_C.accent) : SHELL_C.text,
          fontSize: 13,
          fontWeight: active ? 600 : 400,
          cursor: 'pointer',
        };
      }

      return h(
        'div',
        { style: { height: '100%', display: 'flex', flexDirection: 'column', background: SHELL_C.base, colorScheme: scheme } },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '14px 28px 0',
              flex: '0 0 auto',
            },
          },
          h('button', { type: 'button', onClick: () => setTab('study'), style: pill(tab === 'study') }, '课程'),
          h('button', { type: 'button', onClick: () => setTab('tt'), style: pill(tab === 'tt') }, '课表'),
          h('button', { type: 'button', onClick: () => setTab('interp'), style: pill(tab === 'interp') }, '翻译'),
          h('button', { type: 'button', onClick: () => setTab('detect'), style: pill(tab === 'detect') }, '检测'),
          h('span', { style: { flex: '1 1 auto' } }),
          liveOn
            ? h(
                'span',
                {
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 13,
                    border: '1px solid ' + SHELL_C.accent,
                    color: SHELL_C.accent,
                    fontSize: 12,
                  },
                },
                h('span', {
                  ref: function (node) {
                    if (!node || node.dataset.pulsing) return;
                    node.dataset.pulsing = '1';
                    if (typeof node.animate === 'function') {
                      node.animate([{ opacity: 0.2 }, { opacity: 1 }, { opacity: 0.2 }],
                        { duration: 1100, iterations: Infinity });
                    }
                  },
                  style: { width: 6, height: 6, borderRadius: 3, background: SHELL_C.accent },
                }),
                '同传中',
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: function () { Live.stop(); },
                    style: {
                      border: 'none',
                      background: 'transparent',
                      color: SHELL_C.accent,
                      fontSize: 12,
                      cursor: 'pointer',
                      padding: 0,
                    },
                  },
                  '停止',
                ),
              )
            : null,
          h('span', { style: { fontSize: 11, color: SHELL_C.muted } }, 'v7.15.4'),
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, overflow: 'hidden' } },
          h(
            PanelErrorBoundary,
            { key: tab },
            tab === 'study'
              ? h(StudyModules.Panel)
              : tab === 'tt'
                ? h(StudyModules.Timetable)
                : tab === 'interp'
                  ? h(InterpreterModules.Panel)
                  : h(DetectModules.Panel),
          ),
        ),
      );
    }

    function readableOnShell(cssColor) {
      // 复用一个临时元素解析实际颜色，避免依赖令牌格式
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;background:' + cssColor;
      document.body.appendChild(probe);
      const raw = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      if (!ctx) return '#ffffff';
      ctx.fillStyle = '#000';
      ctx.fillStyle = raw;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      if (d[3] < 128) return '#ffffff';
      const lum = 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
      return lum < 140 ? '#ffffff' : '#111111';
    }

    function SuiteIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M3 5.6A1.6 1.6 0 0 1 4.6 4H10a2.4 2.4 0 0 1 2 1.1A2.4 2.4 0 0 1 14 4h5.4A1.6 1.6 0 0 1 21 5.6v10.9a1.6 1.6 0 0 1-1.6 1.6H14a2.4 2.4 0 0 0-2 1.1 2.4 2.4 0 0 0-2-1.1H4.6A1.6 1.6 0 0 1 3 16.5z' }),
        h('path', { d: 'M12 6.2v13' }),
        h('path', { d: 'M15.5 9.5h3M15.5 12h2' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'study-suite' }, Suite));
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'study-suite', order: 20, label: () => '学习助手' },
            SuiteIcon,
          ),
        );
      },
    };
  },
});
