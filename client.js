window.__ModuleLoader__.load({
  id: '@local/study-suite',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ---- 学习台模块（原 study-panel，作用域隔离避免与同传重名） ----
    const StudyModules = (function () {


    const STORAGE_KEY = 'dsh-study-panel/v5';
    const LEGACY_KEY = 'dsh-study-panel/v4';
    const DEFAULT_SEMESTER_START = '2026-09-28';

    const DEFAULT_LIST_URL = 'https://www.thecn.com/user';
    const ENGINE = 'http://127.0.0.1:8791';

    const DEFAULT_COURSES = [
      {
        name: '2026-09_BLE3022_Effective Writing',
        url: 'https://www.thecn.com/course/91755709/pathway/activity/6ad94a598fcca5b081081741',
      },
      {
        name: '2026-09_MPU3232_Integriti dan Anti-Rasuah',
        url: 'https://www.thecn.com/course/91758968/pathway/activity/6ab61772829463f40d0d7b03',
      },
      {
        name: '2026-09_MPU3411_Extra-curricular Learning Experience 1',
        url: 'https://www.thecn.com/course/91765515/pathway/intro',
      },
      {
        name: '2026-09_MCC3122_Falsafah dan Isu Semasa (Micro-Credential)',
        url: 'https://www.thecn.com/course/91758977/pathway/activity/6abca78846b5d4e5f0015b7a',
      },
      {
        name: '2026-09_SM101_Introduction To Mass Communication',
        url: 'https://www.thecn.com/course/91763204/pathway/activity/6acee3e696ce83447c09e0a8',
      },
      {
        name: '2026-09_SM110_Visual Communication',
        url: 'https://www.thecn.com/course/91763229/pathway/activity/6ace1ec11489d6553409e27b',
      },
      {
        name: '2026-09_SM109_Basic Photography',
        url: 'https://www.thecn.com/course/91763220/pathway/activity/6ab5f3204532e9a6fe019136',
      },
      {
        name: '2026-09_SM112_Introduction To Public Speaking',
        url: 'https://www.thecn.com/course/91763230/pathway/activity/6abcd3ae638fbcefc108874d',
      },
    ];

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
          setTimetable({ classes: data.classes || [], loading: false, error: '' });
        } catch (err) {
          setTimetable({ classes: [], loading: false, error: '读不到课表' });
        }
      }

      React.useEffect(function () {
        loadTimetable();
      }, []);

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
            Card,
            {
              title: '本周课表',
              note: (function () {
                if (timetable.loading) return '读取中…';
                const today = new Date().getDay() === 0 ? 7 : new Date().getDay();
                const list = timetable.classes.filter(function (c) { return c.day === today; });
                const now = new Date().toTimeString().slice(0, 5);
                const next = list.filter(function (c) { return c.start >= now; })[0];
                if (!list.length) return '今天没课';
                return '今天 ' + list.length + ' 节' + (next ? ' · 下一节 ' + next.start + ' ' + next.course : ' · 今天已上完');
              })(),
              action: h(Button, { onClick: loadTimetable }, '刷新'),
            },
            timetable.error
              ? h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, timetable.error)
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
                            h('span', { style: { fontSize: 12, color: C.muted, flex: '0 0 auto' } }, c.start + '–' + c.end),
                            h('span', { style: { fontSize: 13, fontWeight: 600 } }, c.course),
                            h('span', { style: { fontSize: 12, color: C.muted } }, c.kind),
                            h('span', { style: { fontSize: 12, color: C.muted } }, '· ' + c.room),
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
      const [showDone, setShowDone] = React.useState(false);
      const [filters, setFilters] = React.useState({});
      const [showOtherTeachers, setShowOtherTeachers] = React.useState({});
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
      const linked = state.courses.filter((item) => item.url).length;

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
          setDigest({ loading: false, courses: data.courses || [], fetchedAt: data.fetchedAt || '', error: '' });
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
        try {
          const response = await fetch(ENGINE + '/plan?t=' + Date.now(), { cache: 'no-store' });
          const data = await response.json();
          setPlan({ items: data.items || [], loading: false, error: '' });
          if (manual) setUpdatedAt(new Date().toTimeString().slice(0, 8));
        } catch (err) {
          setPlan({ items: [], loading: false, error: '读不到课程待办' });
        } finally {
          if (manual) setTimeout(function () { setRefreshing(false); }, 600);
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

      const visibleCourses = state.courses.filter(function (c) {
        return showHidden || hiddenCourses.indexOf(c.name) === -1;
      });
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
                  const showing = showOtherTeachers[item.name] ? sections : mine;
                  const body = showing.length === 0
                    ? h('span', { style: { fontSize: 12, color: C.muted } }, '这门课还没有可见的章节内容。')
                    : showing.map(function (section, index) {
                      return h(
                        'div',
                        { key: index, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                        h('span', { style: { fontSize: 12, fontWeight: 600 } }, section.title || '(未命名章节)'),
                        (section.pages || []).slice(0, 8).map(function (page, pageIndex) {
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
              'a',
              {
                href: 'https://www.thecn.com/',
                target: '_blank',
                rel: 'noreferrer',
                onClick: function () {
                  const now = Date.now();
                  setCnLoggedAt(now);
                  try {
                    window.localStorage.setItem('dsh-study-cn-login', String(now));
                  } catch (err) {
                    /* 隐私模式忽略 */
                  }
                },
                title: cnLoggedAt
                  ? '已登录 CN（浏览器 cookie 有效期内）。再点一次会重新打开 CN 页面'
                  : 'CN 的登录是浏览器 cookie；在这里登录一次，此后课程可直接打开',
                style: Object.assign(pillStyle(false), {
                  height: 28,
                  color: cnLoggedAt ? C.accent : C.text,
                  borderColor: cnLoggedAt ? C.accent : C.border,
                }),
              },
              cnLoggedAt ? '✓ CN 已登录' : '登录 CN',
            ),
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
                  showDone ? '只看未完成' : '显示已完成（' + plan.items.filter(function (i) { return i.done; }).length + '）',
                ),
                h(Button, { onClick: function () { loadPlan(true); } }, refreshing ? '刷新中…' : '刷新'),
              ),
            },
            plan.error
              ? h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, plan.error)
              : null,
            plan.items.length === 0 && !plan.loading && !plan.error
              ? h('p', { style: { margin: 0, fontSize: 12, color: C.muted } }, '还没有录入待办。')
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
                    const overdue = item.due && !item.done && item.due < new Date().toISOString().slice(0, 10);
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
                          h('span', { style: { fontSize: 11, color: C.muted } }, item.course),
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
                          ),
                        ),
                        item.note
                          ? h('span', { style: { fontSize: 11, color: C.muted } }, item.note)
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
                                    h(
                                      'a',
                                      {
                                        key: 'read',
                                        href: ENGINE + '/reading.pdf?path=' + encodeURIComponent(readDoc.path),
                                        target: '_blank',
                                        rel: 'noreferrer',
                                        title: '生成中英对照 PDF（原文 + 逐段翻译），可直接保存/打印',
                                        style: {
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          height: 22,
                                          padding: '0 9px',
                                          borderRadius: 11,
                                          border: '1px solid ' + C.accent,
                                          background: C.accent,
                                          color: readableOn(C.accent),
                                          fontSize: 11,
                                          fontWeight: 600,
                                          textDecoration: 'none',
                                        },
                                      },
                                      '中英对照',
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
                              item.url
                                ? h(
                                    'a',
                                    {
                                      href: item.url,
                                      target: '_blank',
                                      rel: 'noreferrer',
                                      style: {
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        height: 22,
                                        padding: '0 8px',
                                        borderRadius: 11,
                                        border: '1px solid ' + C.border,
                                        color: C.muted,
                                        fontSize: 11,
                                        textDecoration: 'none',
                                      },
                                    },
                                    '打开课程',
                                  )
                                : null,
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
      const [docText, setDocText] = React.useState('');
      const [docResult, setDocResult] = React.useState('');
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

      React.useEffect(
        function () {
          return function () {
            liveRef.current = false;
            if (streamRef.current) streamRef.current.getTracks().forEach((track) => track.stop());
          };
        },
        [],
      );

      React.useEffect(
        function () {
          let alive = true;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2500);
          callEngine('/health', null, controller.signal)
            .then((data) => {
              if (!alive) return;
              setStatus('online');
              setTermCount((data && data.glossary && data.glossary.en_zh) || 0);
              const loaded = (data && data.idleUnload && data.idleUnload.loaded) || {};
              setMem({ llm: !!loaded.llm, asr: !!loaded.asr });
            })
            .catch(() => alive && setStatus('offline'))
            .finally(() => clearTimeout(timer));
          return function () {
            alive = false;
            clearTimeout(timer);
            controller.abort();
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
          engine: engine,
        });
        return data;
      }

      async function translateDoc() {
        setBusy(true);
        setError('');
        try {
          const data = await run(docText, to, 4, verify);
          if (data) {
            setDocResult(data.text);
            setDocPairs(Array.isArray(data.pairs) ? data.pairs : []);
            setDocMs(data.ms);
            setSim(typeof data.similarity === 'number' ? data.similarity : null);
            setBack(data.back || '');
            setStatus('online');
          }
        } catch (err) {
          setError(err.message);
          setStatus('offline');
        } finally {
          setBusy(false);
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

      async function startLive() {
        if (mic !== 'idle') return;
        setMic('live');
        setError('');
        liveRef.current = true;
        try {
          while (liveRef.current) {
            const blob = await recordOnce(6000);
            if (!liveRef.current) break;
            try {
              const pair = await processClip(blob);
              if (pair) {
                setSubs((prev) => [{ id: String(Date.now()), ...pair }].concat(prev).slice(0, 60));
                liveSegmentsRef.current = liveSegmentsRef.current.concat(pair.segments || []);
                setStatus('online');
              }
            } catch (err) {
              setError(err.message);
            }
          }
        } catch (err) {
          setError(err.message);
        } finally {
          liveRef.current = false;
          setMic('idle');
          if (liveSegmentsRef.current.length) {
            buildMinutes(liveSegmentsRef.current);
            liveSegmentsRef.current = [];
          }
        }
      }

      function stopLive() {
        liveRef.current = false;
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
            onClick: () => setEngine('fast'),
            title: 'opus-mt，80–150ms，术语靠词表保证',
            style: pillStyle(engine === 'fast'),
          },
          '快速',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => setEngine('llm'),
            title: 'Qwen2.5-7B 本地大模型，2–5 秒，语境与格式更好',
            style: pillStyle(engine === 'llm'),
          },
          '精准 7B',
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
        { title: '文档 / 论文翻译', note: '断网可用 · 整段粘贴' },
        h('textarea', {
          value: docText,
          onChange: (event) => setDocText(event.target.value),
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
          h(Button, { onClick: translateDoc, primary: true, disabled: busy || !docText.trim() }, busy ? '翻译中…' : '精翻'),
          h(Button, { onClick: () => { setDocText(''); setDocResult(''); setDocPairs([]); setError(''); setSim(null); setBack(''); } }, '清空'),
          h('span', { title: '译完后自动回译成原文语言，与原文比对，给出一致度评分' },
            h(Checkbox, { checked: verify, onChange: setVerify, label: '复核' }),
          ),
          h('span', { style: { flex: '1 1 auto' } }),
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

      const voicePane = h(
        Card,
        { title: '语音转写 + 翻译', note: '降噪 · 静音过滤 · 全本地' },
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h(
            Button,
            { onClick: recordShot, primary: true, disabled: mic !== 'idle' },
            mic === 'shot' ? '录音中（8 秒）…' : '录一段（8 秒）',
          ),
          h(
            Button,
            { onClick: mic === 'live' ? stopLive : startLive, disabled: mic === 'shot' },
            mic === 'live' ? '停止听写' : '连续听写',
          ),
          mic === 'live'
            ? h('span', { style: { fontSize: 12, color: C.muted } }, '每 6 秒出一段字幕')
            : null,
          h(
            Button,
            {
              onClick: () => {
                const all = [];
                subs.forEach((item) => (item.segments || []).forEach((seg) => all.push(seg)));
                buildMinutes(all);
              },
              disabled: mic !== 'idle' || subs.length === 0,
            },
            '生成纪要',
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('span', { style: { fontSize: 12, color: C.muted, flex: '0 0 auto' } }, '音频输入'),
          h(
            'select',
            {
              value: deviceId,
              onChange: (event) => setDeviceId(event.target.value),
              style: {
                height: 28,
                minWidth: 220,
                padding: '0 8px',
                borderRadius: 8,
                border: '1px solid ' + C.border,
                background: C.base,
                color: C.text,
                fontSize: 12,
              },
            },
            h('option', { value: '' }, '系统默认麦克风'),
            devices.map((device, index) =>
              h('option', { key: device.deviceId || index, value: device.deviceId },
                device.label || '输入设备 ' + (index + 1)),
            ),
          ),
          h(Button, { onClick: refreshDevices }, '刷新'),
          devices.some((d) => /blackhole/i.test(d.label || ''))
            ? h('span', { style: { fontSize: 11, color: C.ok } }, '已检测到 BlackHole（可录系统声音）')
            : null,
        ),
        h(
          'p',
          { style: { margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.7 } },
          '四层过滤：浏览器回声消除 + 降噪 + 自动增益 → 音量门限 → 服务端 VAD 丢弃非语音段 → Whisper 自身抗噪。首次点击会请求麦克风权限。',
        ),
        minutes
          ? h(
              'div',
              {
                style: {
                  padding: '12px 14px',
                  borderRadius: 10,
                  border: '1px solid ' + C.border,
                  background: C.base,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                },
              },
              minutes.loading
                ? h('span', { style: { fontSize: 12, color: C.muted } }, '正在生成纪要（本地 7B 模型，约 5–10 秒）…')
                : minutes.error
                  ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, '纪要生成失败：' + minutes.error)
                  : h(
                      React.Fragment,
                      null,
                      h('div', { style: { fontSize: 14, fontWeight: 600 } }, (minutes.data && minutes.data['标题']) || '课堂纪要'),
                      ((minutes.data && minutes.data['要点']) || []).length
                        ? h(
                            'ul',
                            { style: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 } },
                            (minutes.data['要点'] || []).map((point, index) =>
                              h('li', { key: 'p' + index, style: { fontSize: 13, lineHeight: 1.6 } }, point),
                            ),
                          )
                        : null,
                      ((minutes.data && minutes.data['待办']) || []).length
                        ? h(
                            'div',
                            { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                            h('span', { style: { fontSize: 12, fontWeight: 600, color: C.muted } }, '待办'),
                            (minutes.data['待办'] || []).map((todo, index) =>
                              h('span', { key: 't' + index, style: { fontSize: 13 } }, '□ ' + todo),
                            ),
                          )
                        : null,
                      ((minutes.data && minutes.data['术语']) || []).length
                        ? h(
                            'div',
                            { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                            (minutes.data['术语'] || []).map((pair, index) =>
                              h(
                                'span',
                                {
                                  key: 'g' + index,
                                  style: {
                                    fontSize: 11,
                                    padding: '1px 6px',
                                    borderRadius: 6,
                                    border: '1px solid ' + C.border,
                                    color: C.muted,
                                  },
                                },
                                Array.isArray(pair) ? pair.join(' → ') : String(pair),
                              ),
                            ),
                          )
                        : null,
                      minutes.path
                        ? h('span', { style: { fontSize: 11, color: C.muted, wordBreak: 'break-all' } }, '已保存：' + minutes.path)
                        : null,
                    ),
            )
          : null,
        subs.length === 0
          ? h('p', { style: { margin: 0, fontSize: 12, color: C.muted } }, '还没有字幕。点「录一段」试试。')
          : h(
              'ul',
              { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 } },
              subs.map((item) =>
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
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
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
                              flex: '0 0 auto',
                            },
                          },
                          item.speaker,
                        )
                      : null,
                    h('span', { style: { flex: '1 1 auto', fontSize: 12, color: C.muted, wordBreak: 'break-word' } }, item.src),
                  ),
                  h('span', { style: { fontSize: 13, fontWeight: 500, wordBreak: 'break-word' } }, item.dst),
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
                onClick: () => setNonce((n) => n + 1),
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
                error + '（本地引擎没启动时，重启 DSH 会自动拉起）',
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
                  accept: '.txt,.md,.docx,.pdf,image/*',
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

    function Suite() {
      const scheme = useAppColorScheme();
      const [tab, setTab] = React.useState('study');

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
          h('span', { style: { fontSize: 11, color: SHELL_C.muted } }, 'v5.8.0'),
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, overflow: 'hidden' } },
          tab === 'study'
            ? h(StudyModules.Panel)
            : tab === 'tt'
              ? h(StudyModules.Timetable)
              : tab === 'interp'
                ? h(InterpreterModules.Panel)
                : h(DetectModules.Panel),
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
