// ==UserScript==
// @name         Twitter / X 页面优化
// @namespace    twitter-enhancer
// @version      0.0.3
// @author       twitter-enhancer
// @description  推特（X）网页体验优化：宽时间线、推文新样式、页内设置面板
// @match        https://x.com/*
// @match        https://www.x.com/*
// @match        https://twitter.com/*
// @match        https://www.twitter.com/*
// @match        https://mobile.twitter.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @noframes
// ==/UserScript==

(function() {
	"use strict";
	var s = new Set();
	var _css = async (t) => {
		if (s.has(t)) return;
		s.add(t);
		((c) => {
			if (typeof GM_addStyle === "function") GM_addStyle(c);
			else (document.head || document.documentElement).appendChild(document.createElement("style")).append(c);
		})(t);
	};
	var FLUSH_MS = 120;
	var ADDED_POOL_LIMIT = 3e3;
	var SAMPLE_LIMIT = 8;
	var PRIMARY_SELECTOR = "[data-testid=\"primaryColumn\"]";
	var SIDEBAR_SELECTOR = "[data-testid=\"sidebarColumn\"]";
	var LOGO_SELECTOR = "a[aria-label=\"X\"]";
	var lastPrimary = null;
	var lastSidebar = null;
	var lastRow$2 = null;
	var lastLogo = null;
	function structuralAnchorChanged() {
		const primary = document.querySelector(PRIMARY_SELECTOR);
		const sidebar = document.querySelector(SIDEBAR_SELECTOR);
		const row = primary?.parentElement ?? null;
		const logo = document.querySelector(LOGO_SELECTOR);
		if (primary === lastPrimary && sidebar === lastSidebar && row === lastRow$2 && logo === lastLogo) return false;
		lastPrimary = primary;
		lastSidebar = sidebar;
		lastRow$2 = row;
		lastLogo = logo;
		return true;
	}
	var started$1 = false;
	var timer = null;
	var observer = null;
	var count = 0;
	var samples = [];
	var addedPool = [];
	var overflow = false;
	var structuralPending = false;
	var listeners$1 = new Set();
	function scheduleFlush() {
		if (timer !== null) return;
		timer = setTimeout(() => {
			timer = null;
			flush();
		}, FLUSH_MS);
	}
	function flush() {
		if (count === 0 && addedPool.length === 0) return;
		const detail = {
			count,
			samples,
			added: addedPool,
			overflow,
			structural: structuralPending
		};
		count = 0;
		samples = [];
		addedPool = [];
		overflow = false;
		structuralPending = false;
		for (const listener of [...listeners$1]) try {
			listener(detail);
		} catch (error) {
			console.error("[twitter-enhancer] dom-watch 订阅方执行失败", error);
		}
	}
	function startDomWatch() {
		if (started$1) return;
		started$1 = true;
		try {
			observer = new MutationObserver((records) => {
				count += records.length;
				for (const record of records) {
					if (samples.length < SAMPLE_LIMIT) samples.push(record);
					for (const node of record.addedNodes) {
						if (!(node instanceof Element)) continue;
						if (addedPool.length >= ADDED_POOL_LIMIT) {
							overflow = true;
							continue;
						}
						addedPool.push(node);
					}
				}
				if (structuralAnchorChanged()) {
					structuralPending = true;
					flushDomWatch();
				} else scheduleFlush();
			});
			observer.observe(document.documentElement, {
				childList: true,
				subtree: true
			});
			document.addEventListener("visibilitychange", () => {
				if (!document.hidden) flushDomWatch();
			});
		} catch (error) {
			console.error("[twitter-enhancer] 无法建立 DOM 观察器", error);
			observer = null;
		}
	}
	function onDomChanged(listener) {
		listeners$1.add(listener);
		return () => {
			listeners$1.delete(listener);
		};
	}
	function flushDomWatch() {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		flush();
	}
	function dispatchLayoutEvent() {
		try {
			document.dispatchEvent(new CustomEvent("te:layout"));
		} catch {}
	}
	var ROUTE_EVENT = "te:route";
	function onRouteChanged(listener) {
		const handler = (event) => {
			const detail = event.detail;
			listener({ url: detail?.url ?? location.href });
		};
		document.addEventListener(ROUTE_EVENT, handler);
		return () => {
			document.removeEventListener(ROUTE_EVENT, handler);
		};
	}
	var started = false;
	function startRouteWatch() {
		if (started) return;
		started = true;
		const notify = () => {
			try {
				document.dispatchEvent(new CustomEvent(ROUTE_EVENT, { detail: { url: location.href } }));
			} catch {}
		};
		for (const method of ["pushState", "replaceState"]) {
			const original = history[method];
			if (typeof original !== "function") continue;
			history[method] = function patched(...args) {
				const result = original.apply(this, args);
				notify();
				return result;
			};
		}
		window.addEventListener("popstate", notify);
		window.addEventListener("hashchange", notify);
	}
	var CONFIG = {
		timelineWidth: 800,
		timelineWide: true,
		lockedWidthRange: [560, 660],
		tweetUi: {
			enabledByDefault: true,
			bodyFontSize: 16,
			bodyLineHeight: 1.5,
			measure: "72ch"
		},
		sidebar: {
			hiddenByDefault: true,
			anchorSidebar: true
		},
		media: {
			cap: true,
			fit: true,
			lockWidth: 566,
			maxHeight: 700,
			chromeAllowance: 320,
			minHeight: 320
		},
		column: {
			enabledByDefault: true,
			actionGap: 32,
			shortMaxChars: 32,
			emojiFontSize: 24,
			shortFontSize: 20,
			carouselIndex: true
		},
		search: {
			enabled: true,
			mode: "custom",
			placeholder: "搜索"
		},
		settings: {
			right: 20,
			gap: 12,
			fallbackBottom: 146,
			fab: {
				size: 55,
				radius: 16,
				iconSize: 32
			}
		}
	};
	var items = [];
	var listeners = new Set();
	function registerSetting(item) {
		const index = items.findIndex((existing) => existing.id === item.id);
		if (index >= 0) items[index] = item;
		else items.push(item);
		notifySettingsChanged();
	}
	function getSettings() {
		return items;
	}
	function onSettingsChanged(listener) {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}
	function notifySettingsChanged() {
		for (const listener of [...listeners]) try {
			listener();
		} catch (error) {
			console.error("[twitter-enhancer] 设置面板刷新失败", error);
		}
	}
	var _GM_getValue = (() => typeof GM_getValue != "undefined" ? GM_getValue : void 0)();
	var _GM_setValue = (() => typeof GM_setValue != "undefined" ? GM_setValue : void 0)();
	var KEY_PREFIX = "twitter-enhancer:";
	function gmAvailable() {
		return typeof _GM_getValue === "function" && typeof _GM_setValue === "function";
	}
	function parseValue(value) {
		if (typeof value === "boolean") return value;
		if (value === "true" || value === "on") return true;
		if (value === "false" || value === "off") return false;
		return null;
	}
	async function readFlag(name) {
		const key = KEY_PREFIX + name;
		if (gmAvailable()) try {
			const parsed = parseValue(await _GM_getValue(key, null));
			if (parsed !== null) return parsed;
		} catch {}
		try {
			return parseValue(localStorage.getItem(key));
		} catch {
			return null;
		}
	}
	async function writeFlag(name, value) {
		const key = KEY_PREFIX + name;
		if (gmAvailable()) try {
			await _GM_setValue(key, value);
		} catch {}
		try {
			localStorage.setItem(key, String(value));
		} catch {}
	}
	var ATTR = "teScriptSized";
	var SELECTOR = "[data-te-script-sized]";
	function markScriptSized(el) {
		if (!el.dataset[ATTR]) el.dataset[ATTR] = "1";
	}
	function unmarkScriptSized(el) {
		delete el.dataset[ATTR];
	}
	function isScriptSized(el) {
		return el.closest(SELECTOR) !== null;
	}
	var FLAG$1 = "teWidthUnlocked";
	var CONTENT_UNIT = "[data-testid=\"cellInnerDiv\"], article[data-testid=\"tweet\"]";
	function isLockedValue(value, containerWidth, range, opts) {
		if (!value.endsWith("px")) return false;
		const n = Number.parseFloat(value);
		if (Number.isNaN(n) || n <= 0) return false;
		const [min, max] = range;
		return n >= min && n <= max && containerWidth - n >= opts.tolerance;
	}
	function createWidthUnlocker(containerSelector, options = {}) {
		const opts = {
			lockedRange: options.lockedRange ?? [560, 660],
			nativeWidth: options.nativeWidth ?? (() => 0),
			tolerance: options.tolerance ?? 40,
			isActive: options.isActive ?? (() => true)
		};
		function lockedRange() {
			const [fallbackMin, fallbackMax] = opts.lockedRange;
			const native = opts.nativeWidth();
			if (!(native > 0)) return [fallbackMin, fallbackMax];
			const half = (fallbackMax - fallbackMin) / 2;
			return [native - half, native + half];
		}
		let touched = [];
		let container = null;
		let resizeObserver = null;
		let unsubscribe = null;
		let resizeHandler = null;
		let visibilityHandler = null;
		let domContentLoadedHandler = null;
		let scannedWidth = -1;
		let stopped = true;
		let active = true;
		let pendingUnits = null;
		let frameQueued = false;
		const FALLBACK_FRAME_MS = 16;
		function queueFrameWork() {
			if (frameQueued || stopped) return;
			frameQueued = true;
			const run = () => {
				frameQueued = false;
				runFrameWork();
			};
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
			else setTimeout(run, FALLBACK_FRAME_MS);
		}
		function reset() {
			for (const el of touched) delete el.dataset[FLAG$1];
			touched = [];
			pendingUnits = null;
			scannedWidth = -1;
		}
		function unlock(el) {
			if (!(el instanceof HTMLElement)) return;
			if (el.dataset[FLAG$1] || !container) return;
			if (isScriptSized(el)) return;
			const containerWidth = container.clientWidth;
			if (containerWidth <= 0) return;
			const style = getComputedStyle(el);
			const range = lockedRange();
			const widthLocked = isLockedValue(style.width, containerWidth, range, opts);
			const maxLocked = isLockedValue(style.maxWidth, containerWidth, range, opts);
			if (!widthLocked && !maxLocked) return;
			el.dataset[FLAG$1] = widthLocked ? "fixed" : "max";
			touched.push(el);
		}
		function considerUnit(unit) {
			if (!container || !unit.isConnected || !container.contains(unit)) return;
			for (let el = unit; el && el !== container.parentElement; el = el.parentElement) unlock(el);
		}
		function runFrameWork() {
			if (stopped) return;
			if (!ensureActive()) return;
			if (!ensureContainer()) return;
			const units = pendingUnits;
			pendingUnits = null;
			if (units) for (const unit of units) considerUnit(unit);
		}
		function scanAll() {
			if (!container) return;
			for (const unit of container.querySelectorAll(CONTENT_UNIT)) considerUnit(unit);
		}
		function fullRescan() {
			reset();
			if (!ensureContainer()) return;
			scanAll();
		}
		function ensureActive() {
			const next = opts.isActive();
			if (next === active) return next;
			active = next;
			if (next) fullRescan();
			else reset();
			return next;
		}
		function ensureContainer() {
			if (container && container.isConnected) return container;
			container = document.querySelector(containerSelector);
			if (!container) return null;
			reset();
			resizeObserver?.disconnect();
			if (typeof ResizeObserver !== "undefined") {
				resizeObserver = new ResizeObserver(() => {
					if (!container || stopped) return;
					const w = container.clientWidth;
					if (Math.abs(w - scannedWidth) > opts.tolerance) {
						scannedWidth = w;
						fullRescan();
					}
				});
				resizeObserver.observe(container);
			}
			scannedWidth = container.clientWidth;
			scanAll();
			return container;
		}
		function collectUnits(node) {
			if (!node.isConnected) return;
			if (!pendingUnits) pendingUnits = new Set();
			if (node.matches(CONTENT_UNIT)) pendingUnits.add(node);
			for (const unit of node.querySelectorAll(CONTENT_UNIT)) pendingUnits.add(unit);
		}
		return {
			start() {
				stopped = false;
				active = opts.isActive();
				if (ensureActive()) fullRescan();
				domContentLoadedHandler = () => {
					if (ensureActive()) fullRescan();
				};
				if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", domContentLoadedHandler, { once: true });
				unsubscribe = onDomChanged(({ added, overflow: hadOverflow }) => {
					if (stopped) return;
					if (!ensureActive()) return;
					if (!container || !container.isConnected) {
						fullRescan();
						return;
					}
					if (hadOverflow) {
						fullRescan();
						return;
					}
					for (const node of added) {
						if (!container.contains(node)) continue;
						collectUnits(node);
					}
					if (pendingUnits) queueFrameWork();
				});
				resizeHandler = () => {
					if (ensureActive()) fullRescan();
				};
				window.addEventListener("resize", resizeHandler);
				visibilityHandler = () => {
					if (!document.hidden && ensureActive()) fullRescan();
				};
				document.addEventListener("visibilitychange", visibilityHandler);
			},
			sync() {
				if (stopped) return;
				if (!ensureActive()) return;
				fullRescan();
			},
			stop() {
				stopped = true;
				resizeObserver?.disconnect();
				resizeObserver = null;
				unsubscribe?.();
				unsubscribe = null;
				if (domContentLoadedHandler) document.removeEventListener("DOMContentLoaded", domContentLoadedHandler);
				if (resizeHandler) window.removeEventListener("resize", resizeHandler);
				if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
				reset();
				container = null;
			}
		};
	}
	_css(":root{--te-timeline-width:600px}@media (min-width:1095px){html[data-te-timeline=wide] div[data-testid=primaryColumn]{width:var(--te-timeline-width)!important;min-width:0!important;max-width:var(--te-timeline-width)!important}html[data-te-timeline=wide] div[data-testid=primaryColumn]>div{width:100%!important;max-width:100%!important}html[data-te-timeline=wide] div[data-testid=primaryColumn] [data-testid=cellInnerDiv],html[data-te-timeline=wide] div[data-testid=primaryColumn] [data-testid=tweet],html[data-te-timeline=wide] div[data-testid=primaryColumn] article,html[data-te-timeline=wide] div[data-testid=primaryColumn] [aria-label*=Timeline],html[data-te-timeline=wide] div[data-testid=primaryColumn] [aria-label*=时间线],html[data-te-timeline=wide] div[data-testid=primaryColumn] [role=region]>div>div{max-width:100%!important}html[data-te-timeline=wide] div[data-testid=sidebarColumn]{min-width:290px!important}}html[data-te-timeline=wide] [data-te-width-unlocked]{max-width:100%!important}html[data-te-timeline=wide] [data-te-width-unlocked=fixed]{width:100%!important;min-width:0!important}");
	var PRIMARY_COLUMN = "div[data-testid=\"primaryColumn\"]";
	var SIDEBAR_COLUMN = "div[data-testid=\"sidebarColumn\"]";
	var MIN_WIDTH = 600;
	var EDGE = 16;
	var SIDEBAR_GAP$1 = 30;
	var BREAKPOINT = 1095;
	var WIDTH_GUARD_TOLERANCE = 1;
	var SIDEBAR_ATTR = "teSidebar";
	var SIDEBAR_HIDDEN = "off";
	var CHAT_ROUTE = /^\/i\/chat(\/|$)/;
	var wide = CONFIG.timelineWide;
	var lastEnabled = null;
	var lastTarget = 0;
	var lastMinWidth = "";
	var lastRow$1 = null;
	var widenedByUs = new WeakSet();
	var unlocker = null;
	var nativeColumnWidth = 0;
	function disableTimelineLayout(row) {
		if (lastEnabled === false) return;
		if (row) clearRowStyle(row);
		if (lastRow$1 && lastRow$1 !== row) clearRowStyle(lastRow$1);
		lastRow$1 = null;
		lastTarget = 0;
		lastMinWidth = "";
		lastEnabled = false;
		document.documentElement.dataset.teTimeline = "off";
		dispatchLayoutEvent();
	}
	function clearRowStyle(row) {
		if (!row) return;
		row.style.removeProperty("min-width");
		row.removeAttribute("data-te-row");
	}
	function findRowSidebar(row) {
		for (const child of Array.from(row.children)) if (child.matches(SIDEBAR_COLUMN)) return child;
		return null;
	}
	function hasRowSidebar() {
		const row = document.querySelector(PRIMARY_COLUMN)?.parentElement;
		return !!row && findRowSidebar(row) !== null;
	}
	function sidebarHiddenByUs() {
		return document.documentElement.dataset[SIDEBAR_ATTR] === SIDEBAR_HIDDEN;
	}
	function sidebarReservedMargin(sidebar) {
		return Number.parseFloat(getComputedStyle(sidebar).marginRight) || 0;
	}
	function sidebarVisibleOuter(sidebar) {
		if (sidebar.getClientRects().length === 0) return 0;
		return sidebar.getBoundingClientRect().width + sidebarReservedMargin(sidebar) + SIDEBAR_GAP$1;
	}
	function timelineTarget(row, sidebar, hidden) {
		if (hidden) {
			const rowWidth = row.clientWidth;
			if (rowWidth <= 0) return 0;
			return Math.max(MIN_WIDTH, Math.round(rowWidth - sidebarReservedMargin(sidebar)));
		}
		const available = window.innerWidth - row.getBoundingClientRect().left - EDGE - sidebarVisibleOuter(sidebar);
		return Math.max(MIN_WIDTH, Math.min(CONFIG.timelineWidth, Math.round(available)));
	}
	function writeTimelineLayout() {
		const root = document.documentElement;
		const primary = document.querySelector(PRIMARY_COLUMN);
		const row = primary?.parentElement ?? null;
		if (CHAT_ROUTE.test(window.location.pathname)) {
			disableTimelineLayout(row);
			return;
		}
		if (!primary || !row) return;
		const sidebar = findRowSidebar(row);
		if (!sidebar) {
			disableTimelineLayout(row);
			return;
		}
		if (lastRow$1 && lastRow$1 !== row) clearRowStyle(lastRow$1);
		const hidden = sidebarHiddenByUs();
		const target = timelineTarget(row, sidebar, hidden);
		if (target <= 0) return;
		const primaryWidth = primary.getBoundingClientRect().width;
		if (root.dataset.teTimeline !== "wide" && primaryWidth > 0) nativeColumnWidth = primaryWidth;
		if (!widenedByUs.has(primary) && primaryWidth > target + WIDTH_GUARD_TOLERANCE) {
			disableTimelineLayout(row);
			return;
		}
		if (!wide || window.innerWidth < BREAKPOINT) {
			disableTimelineLayout(row);
			return;
		}
		root.dataset.teTimeline = "wide";
		const wantRowStyle = !hidden;
		const minWidth = wantRowStyle ? `${Math.round(target + sidebarVisibleOuter(sidebar))}px` : "";
		const geometryChanged = lastEnabled !== true || (wantRowStyle ? lastRow$1 !== row : lastRow$1 !== null) || target !== lastTarget || minWidth !== lastMinWidth;
		lastEnabled = true;
		lastTarget = target;
		lastMinWidth = minWidth;
		if (!geometryChanged) return;
		root.style.setProperty("--te-timeline-width", `${target}px`);
		root.dataset.teTimelineWidth = String(target);
		widenedByUs.add(primary);
		if (wantRowStyle) {
			row.style.minWidth = minWidth;
			row.dataset.teRow = "1";
			lastRow$1 = row;
		} else if (lastRow$1) {
			clearRowStyle(lastRow$1);
			lastRow$1 = null;
		}
		dispatchLayoutEvent();
	}
	function applyTimelineLayout() {
		writeTimelineLayout();
		unlocker?.sync();
	}
	function toggleWide() {
		wide = !wide;
		applyTimelineLayout();
		writeFlag("timeline-wide", wide);
		notifySettingsChanged();
	}
	function enableTimelineWidth() {
		unlocker = createWidthUnlocker(PRIMARY_COLUMN, {
			lockedRange: CONFIG.lockedWidthRange,
			nativeWidth: () => nativeColumnWidth,
			isActive: () => document.documentElement.dataset.teTimeline === "wide"
		});
		unlocker.start();
		let layoutScheduled = false;
		const scheduleLayout = () => {
			if (layoutScheduled) return;
			layoutScheduled = true;
			requestAnimationFrame(() => {
				layoutScheduled = false;
				applyTimelineLayout();
			});
		};
		applyTimelineLayout();
		readFlag("timeline-wide").then((stored) => {
			if (stored !== null && stored !== wide) {
				wide = stored;
				applyTimelineLayout();
			}
		});
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scheduleLayout, { once: true });
		window.addEventListener("load", scheduleLayout, { once: true });
		window.addEventListener("resize", scheduleLayout);
		document.addEventListener("te:layout", scheduleLayout);
		onRouteChanged(() => scheduleLayout());
		let hadPrimary = document.querySelector(PRIMARY_COLUMN) !== null;
		let hadSidebar = document.querySelector(SIDEBAR_COLUMN) !== null;
		let hadRowSidebar = hasRowSidebar();
		onDomChanged(({ overflow: hadOverflow, structural }) => {
			const nowPrimary = document.querySelector(PRIMARY_COLUMN) !== null;
			const nowSidebar = document.querySelector(SIDEBAR_COLUMN) !== null;
			const nowRowSidebar = hasRowSidebar();
			const relevant = hadOverflow || structural || nowPrimary !== hadPrimary || nowSidebar !== hadSidebar || nowRowSidebar !== hadRowSidebar;
			hadPrimary = nowPrimary;
			hadSidebar = nowSidebar;
			hadRowSidebar = nowRowSidebar;
			if (!relevant) return;
			if (structural) applyTimelineLayout();
			else scheduleLayout();
		});
		registerSetting({
			id: "timeline-wide",
			group: "布局",
			label: "宽时间线",
			description: "主列铺满 X 内容区；右栏显示时最多放宽到 800px",
			isEnabled: () => wide,
			toggle: toggleWide
		});
	}
	_css(":root{--te-gap-1:8px;--te-gap-2:12px;--te-gap-3:20px;--te-gap-4:32px;--te-gap-5:56px;--te-body-size:16px;--te-body-lh:1.5;--te-measure:72ch;--te-text:#0f1419;--te-text-secondary:#536471;--te-border:#00000014;--te-hover:#00000008;--te-quote-hover:#00000005;--te-surface-sunken:#00000009;--te-color-reply:#1d9bf0;--te-tint-reply:#1d9bf01a;--te-color-repost:#00ba7c;--te-tint-repost:#00ba7c1a;--te-color-like:#f91880;--te-tint-like:#f918801a;--te-focus:#1d9bf0;--te-radius:16px;--te-dur:.18s;--te-ease:cubic-bezier(.2, 0, 0, 1)}html[data-te-theme=dim]{--te-text:#e7e9ea;--te-text-secondary:#8b98a5;--te-border:#ffffff17;--te-hover:#ffffff08;--te-quote-hover:#ffffff05;--te-surface-sunken:#ffffff0b}html[data-te-theme=dark]{--te-text:#e7e9ea;--te-text-secondary:#8b98a5;--te-border:#ffffff1a;--te-hover:#ffffff0a;--te-quote-hover:#ffffff08;--te-surface-sunken:#ffffff0d}html[data-te-ui=on] [data-testid=cellInnerDiv]{border-bottom:1px solid var(--te-border)!important}html[data-te-ui=on] article[data-testid=tweet]{padding:12px 16px 8px}html[data-te-ui=on] [data-testid=tweetText]{font-size:var(--te-body-size);line-height:var(--te-body-lh);max-width:var(--te-measure);text-wrap:pretty;overflow-wrap:anywhere}html[data-te-ui=on] [data-testid=tweetText] a{text-underline-offset:2px}html[data-te-ui=on] [data-testid=User-Name]{font-size:15px}html[data-te-ui=on] [data-testid=User-Name] time,html[data-te-ui=on] [data-testid=User-Name] span:last-child{color:var(--te-text-secondary)}html[data-te-ui=on] [data-testid=tweet] [role=group]{margin-top:var(--te-gap-2)}html[data-te-ui=on] [data-testid=reply],html[data-te-ui=on] [data-testid=retweet],html[data-te-ui=on] [data-testid=unretweet],html[data-te-ui=on] [data-testid=like],html[data-te-ui=on] [data-testid=unlike],html[data-te-ui=on] [data-testid=bookmark],html[data-te-ui=on] [data-testid=share],html[data-te-ui=on] [data-testid=views]{align-items:center;min-width:36px;min-height:36px}html[data-te-ui=on] [data-testid=tweet] [role=group] span{font-variant-numeric:tabular-nums}html[data-te-ui=on] [data-testid=reply] svg,html[data-te-ui=on] [data-testid=retweet] svg,html[data-te-ui=on] [data-testid=unretweet] svg,html[data-te-ui=on] [data-testid=like] svg,html[data-te-ui=on] [data-testid=unlike] svg,html[data-te-ui=on] [data-testid=bookmark] svg,html[data-te-ui=on] [data-testid=share] svg,html[data-te-ui=on] [data-testid=views] svg{transition:color var(--te-dur) var(--te-ease)}html[data-te-ui=on] [data-testid=reply]:hover svg,html[data-te-ui=on] [data-testid=share]:hover svg,html[data-te-ui=on] [data-testid=bookmark]:hover svg,html[data-te-ui=on] [data-testid=views]:hover svg{color:var(--te-color-reply)}html[data-te-ui=on] [data-testid=retweet]:hover svg,html[data-te-ui=on] [data-testid=unretweet]:hover svg{color:var(--te-color-repost)}html[data-te-ui=on] [data-testid=like]:hover svg,html[data-te-ui=on] [data-testid=unlike]:hover svg{color:var(--te-color-like)}html[data-te-ui=on] [data-testid=reply]>div,html[data-te-ui=on] [data-testid=retweet]>div,html[data-te-ui=on] [data-testid=unretweet]>div,html[data-te-ui=on] [data-testid=like]>div,html[data-te-ui=on] [data-testid=unlike]>div,html[data-te-ui=on] [data-testid=bookmark]>div,html[data-te-ui=on] [data-testid=share]>div,html[data-te-ui=on] [data-testid=views]>div{transition:background-color var(--te-dur) var(--te-ease);border-radius:9999px}html[data-te-ui=on] [data-testid=reply]:hover>div,html[data-te-ui=on] [data-testid=share]:hover>div,html[data-te-ui=on] [data-testid=bookmark]:hover>div,html[data-te-ui=on] [data-testid=views]:hover>div{background-color:var(--te-tint-reply)}html[data-te-ui=on] [data-testid=retweet]:hover>div,html[data-te-ui=on] [data-testid=unretweet]:hover>div{background-color:var(--te-tint-repost)}html[data-te-ui=on] [data-testid=like]:hover>div,html[data-te-ui=on] [data-testid=unlike]:hover>div{background-color:var(--te-tint-like)}html[data-te-ui=on] [data-testid=tweetPhoto],html[data-te-ui=on] [data-testid=videoPlayer],html[data-te-ui=on] [data-testid=\"card.layoutLarge.media\"]{overflow:hidden}html[data-te-ui=on] article [data-testid=ScrollSnap-List] [data-testid=tweetPhoto]{border:0;border-radius:0}html[data-te-ui=on] [data-testid=tweet] div[role=link]{border:1px solid var(--te-border);border-radius:var(--te-radius);padding:var(--te-gap-2);margin-top:var(--te-gap-2);transition:background-color var(--te-dur) var(--te-ease)}html[data-te-ui=on] [data-testid=tweet] div[role=link]:hover{background-color:var(--te-quote-hover)}html[data-te-ui=on] [data-testid=tweet] a:focus-visible,html[data-te-ui=on] [data-testid=tweet] button:focus-visible,html[data-te-ui=on] [data-testid=tweet] [role=button]:focus-visible,html[data-te-ui=on] [data-testid=tweet] [role=link]:focus-visible{outline:2px solid var(--te-focus);outline-offset:2px}@media (prefers-reduced-motion:reduce){html[data-te-ui=on] [data-testid=tweet] *{transition-duration:.01ms!important;animation-duration:.01ms!important}}");
	function parseRgb(bg) {
		if (!bg || bg === "transparent") return null;
		const parts = bg.match(/[\d.]+/g)?.map(Number);
		if (!parts || parts.length < 3) return null;
		if (parts.length >= 4 && parts[3] === 0) return null;
		return [
			parts[0],
			parts[1],
			parts[2]
		];
	}
	function detectTheme() {
		try {
			const colorScheme = getComputedStyle(document.documentElement).colorScheme;
			if (colorScheme === "dark") return "dark";
			if (colorScheme === "light") return "light";
		} catch {}
		if (!document.body) return systemPrefersDark() ? "dark" : "light";
		const rgb = parseRgb(getComputedStyle(document.body).backgroundColor);
		if (!rgb) return systemPrefersDark() ? "dark" : "light";
		const [r, g, b] = rgb;
		const luminance = .299 * r + .587 * g + .114 * b;
		if (luminance > 200) return "light";
		if (luminance > 24) return "dim";
		return "dark";
	}
	function systemPrefersDark() {
		try {
			return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
		} catch {
			return false;
		}
	}
	function applyTheme() {
		document.documentElement.dataset.teTheme = detectTheme();
	}
	function applyTokens$1() {
		const root = document.documentElement;
		const { tweetUi } = CONFIG;
		root.style.setProperty("--te-body-size", `${tweetUi.bodyFontSize}px`);
		root.style.setProperty("--te-body-lh", String(tweetUi.bodyLineHeight));
		root.style.setProperty("--te-measure", tweetUi.measure);
	}
	var enabled$1 = CONFIG.tweetUi.enabledByDefault;
	function setEnabled$1(value) {
		enabled$1 = value;
		document.documentElement.dataset.teUi = value ? "on" : "off";
	}
	function toggleTweetUi() {
		setEnabled$1(!enabled$1);
		writeFlag("tweet-ui", enabled$1);
		notifySettingsChanged();
	}
	function enableTweetUi() {
		applyTokens$1();
		applyTheme();
		setEnabled$1(enabled$1);
		readFlag("tweet-ui").then((stored) => {
			if (stored !== null && stored !== enabled$1) setEnabled$1(stored);
		});
		requestAnimationFrame(() => applyTheme());
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyTheme, { once: true });
		let scheduled = false;
		const scheduleThemeSync = () => {
			if (scheduled) return;
			scheduled = true;
			requestAnimationFrame(() => {
				scheduled = false;
				applyTheme();
			});
		};
		const observer = new MutationObserver(scheduleThemeSync);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: [
				"style",
				"class",
				"data-theme",
				"data-color-scheme"
			]
		});
		const startBodyObserve = () => {
			if (document.body) observer.observe(document.body, {
				attributes: true,
				attributeFilter: ["style", "class"]
			});
		};
		if (document.body) startBodyObserve();
		else document.addEventListener("DOMContentLoaded", startBodyObserve, { once: true });
		window.addEventListener("keydown", (event) => {
			if (!event.altKey || event.code !== "KeyU") return;
			toggleTweetUi();
			event.preventDefault();
		});
		registerSetting({
			id: "tweet-ui",
			group: "内容",
			label: "推文新样式",
			description: "正文 16px / 行高 1.5，重绘操作栏、引用卡片与媒体圆角",
			shortcut: "Alt+U",
			isEnabled: () => enabled$1,
			toggle: toggleTweetUi
		});
	}
	_css(":root{--te-search-bg:#eff3f4;--te-search-bg-focus:#fff;--te-search-fg:#0f1419;--te-search-muted:#536471}html[data-te-theme=dim]{--te-search-bg:#202327;--te-search-bg-focus:#15202b;--te-search-fg:#e7e9ea;--te-search-muted:#8b98a5}html[data-te-theme=dark]{--te-search-bg:#202327;--te-search-bg-focus:#000;--te-search-fg:#e7e9ea;--te-search-muted:#8b98a5}html[data-te-sidebar=off] [data-testid=sidebarColumn]{display:none!important}.te-search-host{box-sizing:border-box;z-index:2;padding:0}.te-search-host[data-te-search-layout=row]{flex:1 1 0;min-width:0;position:relative}.te-search-host[data-te-search-layout=absolute]{position:absolute}[data-te-nav-compact=true] .te-search-host,html[data-te-search=off] .te-search-host{display:none}.te-search{box-sizing:border-box;background:var(--te-search-bg);border:1px solid #0000;border-radius:9999px;align-items:center;gap:8px;height:44px;padding:0 16px;transition:background-color .18s cubic-bezier(.2,0,0,1),border-color .18s cubic-bezier(.2,0,0,1);display:flex}.te-search:focus-within{background:var(--te-search-bg-focus);border-color:#1d9bf0}.te-search input{min-width:0;color:var(--te-search-fg);background:0 0;border:none;outline:none;flex:1;font-family:inherit;font-size:15px}.te-search input::placeholder{color:var(--te-search-muted)}.te-search svg{color:var(--te-search-muted);flex:none}.te-search-clear{cursor:pointer;color:#fff;background:#1d9bf0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;width:22px;height:22px;padding:0;display:none}.te-search[data-has-value=true] .te-search-clear{display:flex}.te-search-host [role=search],.te-search-host form[role=search]{width:100%!important;min-width:0!important;max-width:100%!important}@media (prefers-reduced-motion:reduce){.te-search{transition-duration:.01ms}}");
	var SIDEBAR = "[data-testid=\"sidebarColumn\"]";
	var SEARCH_INPUT = "[data-testid=\"SearchBox_Search_Input\"]";
	var SIDEBAR_GAP = 30;
	var NAV_SELECTORS = [
		"nav[aria-label=\"Primary\"]",
		"nav[aria-label=\"主要\"]",
		"nav[role=\"navigation\"]",
		"header[role=\"banner\"] nav",
		"[data-testid=\"SideNav\"]"
	];
	var LOGO_SELECTORS = [
		"a[aria-label=\"X\"]",
		"a[aria-label=\"Twitter\"]",
		"a[href=\"/home\"]"
	];
	var SEARCH_HEIGHT = 44;
	var COMPACT_WIDTH = 240;
	var ROW_STYLE_PROPS = [
		"display",
		"flex-direction",
		"flex-wrap",
		"align-items",
		"justify-content",
		"gap",
		"align-self",
		"min-width"
	];
	function findNav() {
		for (const selector of NAV_SELECTORS) {
			const el = document.querySelector(selector);
			if (el) return el;
		}
		return null;
	}
	function findInner(nav) {
		const parent = nav.parentElement;
		return parent?.parentElement ?? parent ?? nav;
	}
	function findLogo(root, nav) {
		for (const outsideNav of [true, false]) for (const selector of LOGO_SELECTORS) for (const el of root.querySelectorAll(selector)) {
			if (outsideNav && nav.contains(el)) continue;
			return el;
		}
		return null;
	}
	function findLogoRow(logo, inner) {
		let row = logo.parentElement;
		while (row && row !== inner && row !== document.body && row.parentElement && row.parentElement !== inner) row = row.parentElement;
		return row && row !== inner ? row : null;
	}
	function findSidebar() {
		return document.querySelector(SIDEBAR);
	}
	function findNativeSearch() {
		const input = document.querySelector(SEARCH_INPUT);
		if (!input) return null;
		return input.closest("[role=\"search\"]") ?? input.parentElement ?? null;
	}
	function ensureHost() {
		const existing = document.querySelector(".te-search-host");
		if (existing) return existing;
		const host = document.createElement("div");
		host.className = "te-search-host";
		return host;
	}
	function isLogoRow(row, logo) {
		const own = Array.from(row.children).filter((el) => !el.classList.contains("te-search-host"));
		if (own.length === 0 || own.length > 2) return false;
		const rowBox = row.getBoundingClientRect();
		const logoBox = logo.getBoundingClientRect();
		if (rowBox.height === 0 || logoBox.height === 0) return own.length === 1;
		return rowBox.height <= logoBox.height * 1.6;
	}
	function applyRowLayout(row, host) {
		row.style.display = "flex";
		row.style.flexDirection = "row";
		row.style.flexWrap = "nowrap";
		row.style.alignItems = "center";
		row.style.justifyContent = "space-between";
		row.style.gap = "12px";
		row.style.alignSelf = "stretch";
		row.style.minWidth = "0";
		rowChildren = [];
		for (const child of Array.from(row.children)) {
			if (child === host) continue;
			const el = child;
			el.style.flexGrow = "0";
			el.style.flexShrink = "0";
			rowChildren.push(el);
		}
	}
	function resetRowLayout(row) {
		for (const prop of ROW_STYLE_PROPS) row.style.removeProperty(prop);
		for (const el of rowChildren) {
			el.style.removeProperty("flex-grow");
			el.style.removeProperty("flex-shrink");
		}
		rowChildren = [];
	}
	function applyAbsoluteLayout(nav, host, logo) {
		if (getComputedStyle(nav).position === "static") nav.style.position = "relative";
		if (!logo) {
			host.style.top = "4px";
			host.style.left = "12px";
			host.style.right = "12px";
			return;
		}
		const navBox = nav.getBoundingClientRect();
		const logoBox = logo.getBoundingClientRect();
		if (navBox.width === 0 || logoBox.width === 0) return;
		const left = Math.round(logoBox.right - navBox.left + 12);
		const top = Math.round(logoBox.top - navBox.top + Math.max(0, (logoBox.height - SEARCH_HEIGHT) / 2));
		host.style.top = `${top}px`;
		host.style.left = `${left}px`;
		host.style.right = "12px";
	}
	var lastRow = null;
	var rowChildren = [];
	function mountBesideLogo(nav, host) {
		host.removeAttribute("style");
		const inner = findInner(nav);
		const logo = findLogo(inner, nav);
		const row = logo ? findLogoRow(logo, inner) : null;
		if (logo && row && row !== nav && isLogoRow(row, logo)) {
			if (lastRow && lastRow !== row) resetRowLayout(lastRow);
			lastRow = row;
			if (host.parentElement !== row) row.appendChild(host);
			applyRowLayout(row, host);
			host.dataset.teSearchLayout = "row";
		} else {
			if (lastRow) {
				resetRowLayout(lastRow);
				lastRow = null;
			}
			if (host.parentElement !== nav) nav.insertBefore(host, nav.firstChild);
			applyAbsoluteLayout(nav, host, logo);
			host.dataset.teSearchLayout = "absolute";
		}
		const width = inner.clientWidth || nav.clientWidth;
		inner.dataset.teNavCompact = width > 0 && width < COMPACT_WIDTH ? "true" : "false";
	}
	function buildSearchBox(host) {
		if (host.querySelector(".te-search")) return;
		const wrap = document.createElement("form");
		wrap.className = "te-search";
		wrap.setAttribute("role", "search");
		wrap.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7"></circle>
      <path d="M20 20l-3.5-3.5"></path>
    </svg>
    <input type="search" placeholder="${CONFIG.search.placeholder}" aria-label="${CONFIG.search.placeholder}" autocomplete="off" />
    <button class="te-search-clear" type="button" aria-label="清除">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18"></path>
      </svg>
    </button>
  `;
		const input = wrap.querySelector("input");
		wrap.querySelector(".te-search-clear").addEventListener("click", () => {
			input.value = "";
			wrap.dataset.hasValue = "false";
			input.focus();
		});
		input.addEventListener("input", () => {
			wrap.dataset.hasValue = input.value ? "true" : "false";
		});
		wrap.addEventListener("submit", (event) => {
			event.preventDefault();
			const query = input.value.trim();
			if (!query) return;
			window.location.assign(`/search?q=${encodeURIComponent(query)}`);
		});
		host.appendChild(wrap);
	}
	function moveNativeSearch(host) {
		const search = findNativeSearch();
		if (!search) return false;
		if (search.parentElement !== host) host.appendChild(search);
		return true;
	}
	var searchEnabled = CONFIG.search.enabled;
	var anchoredSidebar = null;
	var anchoredRow = null;
	function resetSidebarAnchor() {
		if (anchoredSidebar) {
			anchoredSidebar.style.removeProperty("margin-left");
			anchoredSidebar = null;
		}
		if (anchoredRow) {
			anchoredRow.style.removeProperty("justify-content");
			anchoredRow = null;
		}
	}
	function applySidebarGap() {
		const sidebar = findSidebar();
		const row = sidebar?.parentElement ?? null;
		if (!CONFIG.sidebar.anchorSidebar || hidden || !sidebar || !row) {
			resetSidebarAnchor();
			return;
		}
		row.style.justifyContent = "flex-start";
		sidebar.style.marginLeft = `${SIDEBAR_GAP}px`;
		anchoredSidebar = sidebar;
		anchoredRow = row;
	}
	var hidden = CONFIG.sidebar.hiddenByDefault;
	function applyHidden(value) {
		const attribute = value ? "off" : "on";
		const changed = document.documentElement.dataset.teSidebar !== attribute;
		hidden = value;
		document.documentElement.dataset.teSidebar = attribute;
		applySidebarGap();
		if (changed) dispatchLayoutEvent();
	}
	function toggleSidebar() {
		applyHidden(!hidden);
		writeFlag("sidebar", hidden);
		notifySettingsChanged();
	}
	function watchInner(inner, nav, host) {
		if (typeof ResizeObserver === "undefined") return;
		new ResizeObserver(() => {
			mountBesideLogo(nav, host);
		}).observe(inner);
	}
	function isSearchEnabled() {
		return searchEnabled;
	}
	function applySearchEnabled(value) {
		searchEnabled = value;
		document.documentElement.dataset.teSearch = value ? "on" : "off";
	}
	function toggleSearch() {
		applySearchEnabled(!searchEnabled);
		writeFlag("nav-search", searchEnabled);
		notifySettingsChanged();
	}
	function interceptSlashShortcut() {
		if (CONFIG.search.mode !== "custom") return;
		window.addEventListener("keydown", (event) => {
			if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
			if (!isSearchEnabled()) return;
			const target = event.target;
			if (target) {
				const tag = target.tagName;
				if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
			}
			const input = document.querySelector(".te-search input");
			if (!input) return;
			event.preventDefault();
			event.stopPropagation();
			input.focus();
			input.select();
		}, true);
	}
	function enableSidebarSearch() {
		applyHidden(hidden);
		applySearchEnabled(searchEnabled);
		readFlag("sidebar").then((stored) => {
			if (stored !== null && stored !== hidden) applyHidden(stored);
		});
		readFlag("nav-search").then((stored) => {
			if (stored !== null && stored !== searchEnabled) applySearchEnabled(stored);
		});
		let watching = false;
		const sync = () => {
			const mounted = document.querySelector(".te-search-host");
			if (mounted?.isConnected) {
				if (CONFIG.search.mode === "move") moveNativeSearch(mounted);
				applySidebarGap();
				return;
			}
			const nav = findNav();
			if (!nav) return;
			const host = ensureHost();
			if (CONFIG.search.mode === "move") moveNativeSearch(host);
			else buildSearchBox(host);
			mountBesideLogo(nav, host);
			applySidebarGap();
			if (!watching) {
				watching = true;
				watchInner(findInner(nav), nav, host);
			}
		};
		sync();
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync, { once: true });
		window.addEventListener("load", sync, { once: true });
		onDomChanged(({ added, overflow: hadOverflow, structural }) => {
			if (hadOverflow || structural) {
				sync();
				return;
			}
			const nav = findNav();
			let relevant = false;
			for (const node of added) {
				if (node.matches?.(SIDEBAR) || node.querySelector?.(SIDEBAR)) {
					relevant = true;
					break;
				}
				if (nav && (node.contains(nav) || nav.contains(node))) {
					relevant = true;
					break;
				}
				if (node.matches?.(".te-search-host, [data-testid=\"SearchBox_Search_Input\"]")) {
					relevant = true;
					break;
				}
			}
			if (relevant) sync();
		});
		onRouteChanged(() => sync());
		document.addEventListener("te:layout", applySidebarGap);
		interceptSlashShortcut();
		registerSetting({
			id: "sidebar",
			group: "布局",
			label: "显示右侧栏",
			description: "关闭后隐藏右栏，把横向空间让给主列",
			shortcut: "Alt+B",
			isEnabled: () => !hidden,
			toggle: toggleSidebar
		});
		registerSetting({
			id: "nav-search",
			group: "布局",
			label: "导航条搜索框",
			description: "在左栏 logo 右侧显示搜索框（回车跳转搜索页）",
			isEnabled: isSearchEnabled,
			toggle: toggleSearch
		});
		window.addEventListener("keydown", (event) => {
			if (!event.altKey || event.code !== "KeyB") return;
			toggleSidebar();
			event.preventDefault();
		});
	}
	var MEDIA_SELECTOR = "[data-testid=\"tweetPhoto\"],[data-testid=\"videoPlayer\"]";
	var CAROUSEL_SCOPE = "[data-testid=\"ScrollSnap-List\"]";
	var FLAG = "teMediaCapped";
	var OBSERVED = "teMediaObserved";
	var FLAG_SELECTOR = "[data-te-media-capped]";
	var FIT = "teMediaFit";
	var FIT_SELECTOR = "[data-te-media-fit]";
	var RESIZE_TOLERANCE = 10;
	var RECONCILE_DEBOUNCE = 120;
	var CROP_TOLERANCE = 4;
	var locked = CONFIG.media.cap;
	var fitEnabled = CONFIG.media.fit;
	var inlineOriginals = new WeakMap();
	function writeInline(el, property, value) {
		let record = inlineOriginals.get(el);
		if (!record) {
			record = new Map();
			inlineOriginals.set(el, record);
		}
		if (!record.has(property)) record.set(property, el.style.getPropertyValue(property));
		el.style.setProperty(property, value);
	}
	function restoreInline(el) {
		const record = inlineOriginals.get(el);
		if (!record) return;
		for (const [property, value] of record) if (value === "") el.style.removeProperty(property);
		else el.style.setProperty(property, value);
		inlineOriginals.delete(el);
		if (el.getAttribute("style") === "") el.removeAttribute("style");
	}
	function isActive() {
		if (document.documentElement.dataset.teTimeline !== "wide") return false;
		const primary = document.querySelector("div[data-testid=\"primaryColumn\"]");
		return !!primary && primary.clientWidth > 640;
	}
	function heightBudget() {
		const { maxHeight, minHeight, chromeAllowance } = CONFIG.media;
		const budget = Math.max(minHeight, Math.min(maxHeight, window.innerHeight - chromeAllowance));
		if (document.documentElement.dataset.teMediaBudget !== String(budget)) document.documentElement.dataset.teMediaBudget = String(budget);
		return budget;
	}
	var reconcileTimer = null;
	function scheduleReconcile() {
		if (reconcileTimer !== null) return;
		reconcileTimer = setTimeout(() => {
			reconcileTimer = null;
			reconcileMediaCap();
		}, RECONCILE_DEBOUNCE);
	}
	var FALLBACK_FRAME_MS$1 = 16;
	var frameQueued$1 = false;
	var pendingSeeds = new Set();
	function queueSeed(el) {
		if (!el.isConnected) return;
		pendingSeeds.add(el);
		queueFrameWork$1();
	}
	function queueFrameWork$1() {
		if (frameQueued$1) return;
		frameQueued$1 = true;
		const run = () => {
			frameQueued$1 = false;
			runFrameWork$1();
		};
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
		else setTimeout(run, FALLBACK_FRAME_MS$1);
	}
	function runFrameWork$1() {
		frameQueued$1 = false;
		if (!locked || !isActive()) return;
		const seeds = [...pendingSeeds];
		pendingSeeds.clear();
		for (const seed of seeds) if (seed.isConnected && seed instanceof HTMLElement) reconcileSeed(seed);
	}
	function intrinsicSize(el) {
		let best = null;
		const consider = (width, height) => {
			if (!(width > 0) || !(height > 0)) return;
			if (!best || width * height > best.width * best.height) best = {
				width,
				height
			};
		};
		for (const image of el.querySelectorAll("img")) consider(image.naturalWidth, image.naturalHeight);
		for (const video of el.querySelectorAll("video")) consider(video.videoWidth, video.videoHeight);
		return best;
	}
	function soleMedia(host) {
		if (!fitEnabled) return null;
		const medias = [...host.querySelectorAll(MEDIA_SELECTOR)];
		if (medias.length === 0) return null;
		const outer = medias.filter((m) => !medias.some((other) => other !== m && other.contains(m)));
		if (outer.length !== 1) return null;
		const media = outer[0];
		if (media.closest(CAROUSEL_SCOPE)) return null;
		return intrinsicSize(media) ? media : null;
	}
	function planFit(host, budget) {
		const media = soleMedia(host);
		if (!media) return null;
		const size = intrinsicSize(media);
		if (!size) return null;
		const rowWidth = host.offsetWidth;
		if (rowWidth <= 0) return null;
		if (rowWidth * size.height / size.width <= budget) return null;
		const height = Math.max(1, Math.round(budget));
		const width = Math.round(height * size.width / size.height);
		if (width <= 0 || width >= rowWidth) return null;
		return {
			media,
			width,
			height
		};
	}
	function mediaWrappers(host, media) {
		const wrappers = [];
		let el = media.parentElement;
		while (el && el !== host && wrappers.length < 24) {
			wrappers.push(el);
			el = el.parentElement;
		}
		return el === host ? wrappers : [];
	}
	function applyFit(run, wrappers, plan) {
		const { media, width, height } = plan;
		const pinBox = (el) => {
			writeInline(el, "width", `${width}px`);
			writeInline(el, "height", `${height}px`);
			writeInline(el, "max-width", "none");
			writeInline(el, "max-height", "none");
			el.dataset[FIT] = "1";
			markScriptSized(el);
		};
		for (const box of [media, ...media.querySelectorAll(MEDIA_SELECTOR)]) pinBox(box);
		for (const el of wrappers) {
			if (/calc|%/.test(el.style.paddingBottom ?? "")) writeInline(el, "padding-bottom", "0px");
			pinBox(el);
		}
		for (const el of run) {
			writeInline(el, "width", `${width}px`);
			writeInline(el, "max-width", "none");
			el.dataset[FIT] = "1";
			markScriptSized(el);
		}
	}
	function clearFit(el) {
		restoreInline(el);
		delete el.dataset[FIT];
		unmarkScriptSized(el);
	}
	function unlockHost(host) {
		restoreInline(host);
		delete host.dataset[FLAG];
		delete host.dataset[OBSERVED];
		resizeObserver$1?.unobserve(host);
		for (const fitted of host.querySelectorAll(FIT_SELECTOR)) clearFit(fitted);
		if (host.matches(FIT_SELECTOR)) clearFit(host);
	}
	function reconcileSeed(seed) {
		if (!locked || !isActive()) return;
		const flagged = seed.closest(FLAG_SELECTOR);
		const media = seed.matches(MEDIA_SELECTOR) ? seed : seed.querySelector(MEDIA_SELECTOR);
		const chain = [];
		let el = flagged;
		while (el && el !== document.body && el.dataset[FLAG]) {
			chain.push(el);
			el = el.parentElement;
		}
		for (const item of chain) unlockHost(item);
		const host = (media ? findHost(media) : null) ?? (flagged?.isConnected ? flagged : null);
		if (host) applyCap(host);
	}
	function findHost(el) {
		let p = el.parentElement;
		while (p && p !== document.body) {
			const carousel = p.closest(CAROUSEL_SCOPE);
			if (carousel && carousel !== p) {
				p = p.parentElement;
				continue;
			}
			if (p.offsetWidth >= CONFIG.media.lockWidth) {
				if (!p.querySelector("[data-testid=\"tweetText\"]")) return p;
			}
			p = p.parentElement;
		}
		return null;
	}
	function contentBottomAfterClamp(host) {
		const top = host.getBoundingClientRect().top;
		let bottom = 0;
		for (const media of host.querySelectorAll(MEDIA_SELECTOR)) {
			const rect = media.getBoundingClientRect();
			if (rect.width <= 0) continue;
			if (rect.bottom - top > bottom) bottom = rect.bottom - top;
		}
		return Math.round(bottom);
	}
	function applyCap(host) {
		if (!locked || !isActive()) return;
		if (host.closest(FLAG_SELECTOR)) return;
		if (host.querySelector(FIT_SELECTOR) && !soleMedia(host)) {
			scheduleReconcile();
			return;
		}
		const natural = host.offsetHeight;
		if (natural === 0) return;
		if (natural > window.innerHeight * 2.5) return;
		const budget = heightBudget();
		const run = [host];
		let p = host.parentElement;
		while (p && p !== document.body && run.length < 10) {
			const te = p.getAttribute("data-testid");
			if (p.tagName === "ARTICLE" || te === "cellInnerDiv") break;
			if (te === "primaryColumn" || te === "sidebarColumn") break;
			if (p.querySelector("[data-testid=\"tweetText\"]")) break;
			if (p.querySelector("[data-testid=\"reply\"],[data-testid=\"retweet\"],[data-testid=\"like\"],[data-testid=\"unlike\"],[data-testid=\"bookmark\"]")) break;
			run.push(p);
			p = p.parentElement;
		}
		const writeChain = (height, width) => {
			for (const el of run) {
				writeInline(el, "height", `${height}px`);
				writeInline(el, "max-height", "none");
				if (/calc|%/.test(el.style.paddingBottom ?? "")) writeInline(el, "padding-bottom", "0px");
				if (width !== null) {
					writeInline(el, "width", `${width}px`);
					writeInline(el, "max-width", "none");
					markScriptSized(el);
				}
				el.dataset[FLAG] = "1";
			}
		};
		const plan = planFit(host, budget);
		if (plan) {
			const wrappers = mediaWrappers(host, plan.media);
			writeChain(plan.height, plan.width);
			applyFit(run, wrappers, plan);
			if (contentBottomAfterClamp(host) > plan.height + CROP_TOLERANCE) {
				for (const el of run) unlockHost(el);
				return;
			}
			observeHost(host);
			return;
		}
		if (natural <= budget) {
			if (host.dataset[FLAG]) unlockHost(host);
			return;
		}
		if (host.dataset[FLAG]) return;
		writeChain(budget, null);
		if (contentBottomAfterClamp(host) > budget + CROP_TOLERANCE) {
			for (const el of run) unlockHost(el);
			return;
		}
		observeHost(host);
	}
	function observeHost(host) {
		if (resizeObserver$1 && !host.dataset[OBSERVED]) {
			resizeObserver$1.observe(host);
			host.dataset[OBSERVED] = String(Math.round(host.offsetWidth));
		}
	}
	function onHostResize(host) {
		if (!locked || !isActive()) return;
		const width = Math.round(host.offsetWidth);
		const last = Number(host.dataset[OBSERVED] ?? -1);
		if (Number.isFinite(last) && Math.abs(width - last) < RESIZE_TOLERANCE) return;
		scheduleReconcile();
	}
	var resizeObserver$1 = typeof ResizeObserver !== "undefined" ? new ResizeObserver((entries) => {
		for (const entry of entries) onHostResize(entry.target);
	}) : null;
	function reconcileMediaCap() {
		if (!locked || !isActive()) {
			resetMediaCap();
			return;
		}
		resetMediaCap();
		for (const media of document.querySelectorAll(MEDIA_SELECTOR)) {
			if (!media.isConnected) continue;
			const host = findHost(media);
			if (!host) continue;
			applyCap(host);
		}
		for (const host of document.querySelectorAll(FLAG_SELECTOR)) host.dataset[OBSERVED] = String(Math.round(host.offsetWidth));
	}
	function collectSeeds(nodes) {
		for (const node of nodes) {
			if (!node.isConnected) continue;
			if (node.matches(MEDIA_SELECTOR)) pendingSeeds.add(node);
			for (const media of node.querySelectorAll(MEDIA_SELECTOR)) if (media.isConnected) pendingSeeds.add(media);
		}
		if (pendingSeeds.size > 0) queueFrameWork$1();
	}
	function resetMediaCap() {
		for (const el of document.querySelectorAll(FLAG_SELECTOR)) unlockHost(el);
		for (const el of document.querySelectorAll(FIT_SELECTOR)) clearFit(el);
	}
	function toggleCap() {
		locked = !locked;
		reconcileMediaCap();
		writeFlag("media-cap", locked);
		notifySettingsChanged();
	}
	function toggleFit() {
		fitEnabled = !fitEnabled;
		reconcileMediaCap();
		writeFlag("media-fit", fitEnabled);
		notifySettingsChanged();
	}
	function enableMediaCap() {
		reconcileMediaCap();
		readFlag("media-cap").then((stored) => {
			if (stored !== null && stored !== locked) {
				locked = stored;
				reconcileMediaCap();
			}
		});
		readFlag("media-fit").then((stored) => {
			if (stored !== null && stored !== fitEnabled) {
				fitEnabled = stored;
				reconcileMediaCap();
			}
		});
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", reconcileMediaCap, { once: true });
		window.addEventListener("load", reconcileMediaCap, { once: true });
		onDomChanged(({ added, overflow: hadOverflow }) => {
			if (!locked || !isActive()) return;
			if (hadOverflow) {
				scheduleReconcile();
				return;
			}
			if (added.length === 0) return;
			collectSeeds(added);
		});
		const onLayout = () => {
			if (locked) scheduleReconcile();
		};
		document.addEventListener("te:layout", onLayout);
		onRouteChanged(onLayout);
		const onMediaLoad = (event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (!(target instanceof HTMLImageElement || target instanceof HTMLVideoElement)) return;
			if (!locked || !isActive()) return;
			const seed = target.closest(MEDIA_SELECTOR) ?? target.closest(FLAG_SELECTOR);
			if (seed) queueSeed(seed);
		};
		document.addEventListener("load", onMediaLoad, true);
		document.addEventListener("loadeddata", onMediaLoad, true);
		window.addEventListener("resize", scheduleReconcile);
		document.addEventListener("visibilitychange", () => {
			if (!document.hidden && locked) scheduleReconcile();
		});
		registerSetting({
			id: "media-cap",
			group: "内容",
			label: "媒体高度钳制",
			description: `超高竖图 / 轮播压到 ${CONFIG.media.maxHeight}px 内，一屏看全`,
			isEnabled: () => locked,
			toggle: toggleCap
		});
		registerSetting({
			id: "media-fit",
			group: "内容",
			label: "单图等比",
			description: "超预算的单图按比例缩到预算内并居中，不裁切、不压扁（关：只压高度）",
			isEnabled: () => fitEnabled,
			toggle: toggleFit
		});
	}
	_css(":root{--te-spine:764px}html[data-te-column=on] article[data-testid=tweet] [role=group]{max-width:var(--te-spine,var(--te-measure));gap:var(--te-action-gap,32px)}html[data-te-column=on] [data-testid=cellInnerDiv][data-te-hero-cell]{border-bottom-color:#0000!important}html[data-te-column=on] article[data-testid=tweet][data-te-hero]{padding:20px 16px 0}html[data-te-column=on] article[data-testid=tweet][data-te-hero]:after{content:\"\";height:8px;margin:var(--te-gap-3) -16px 0;background-color:var(--te-surface-sunken);display:block}html[data-te-column=on] article[data-testid=tweet][data-te-caption=emoji] [data-testid=tweetText]{font-size:var(--te-caption-emoji-size,24px);line-height:1.1}html[data-te-column=on] article[data-testid=tweet][data-te-caption=short] [data-testid=tweetText]{font-size:var(--te-caption-short-size,20px);line-height:1.35}html[data-te-column=on] [data-te-carousel]{position:relative}html[data-te-column=on] [data-te-carousel]:after{content:attr(data-te-carousel);top:var(--te-gap-1);right:var(--te-gap-1);font-variant-numeric:tabular-nums;color:#fff;pointer-events:none;background-color:#0000008c;border-radius:9999px;padding:1px 8px;font-size:12px;line-height:18px;position:absolute}");
	var TWEET_SELECTOR = "article[data-testid=\"tweet\"]";
	var TEXT_SELECTOR = "[data-testid=\"tweetText\"]";
	var SNAP_SELECTOR = "[data-testid=\"ScrollSnap-List\"]";
	var CELL_SELECTOR = "[data-testid=\"cellInnerDiv\"]";
	var STATUS_PATH = /^\/[^/]+\/status\/\d+/;
	var CAROUSEL_ATTR = "teCarousel";
	var HERO_ATTR = "teHero";
	var HERO_CELL_ATTR = "teHeroCell";
	var CAPTION_ATTR = "teCaption";
	var HOST_MAX_DEPTH = 6;
	var FALLBACK_FRAME_MS = 16;
	var enabled = CONFIG.column.enabledByDefault;
	var frameQueued = false;
	var pendingArticles = null;
	var fullScanPending = false;
	function queueFrameWork() {
		if (frameQueued) return;
		frameQueued = true;
		const run = () => {
			frameQueued = false;
			runFrameWork();
		};
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
		else setTimeout(run, FALLBACK_FRAME_MS);
	}
	function runFrameWork() {
		if (!enabled) return;
		if (fullScanPending) {
			fullScanPending = false;
			pendingArticles = null;
			scanAll();
			return;
		}
		const batch = pendingArticles;
		pendingArticles = null;
		if (!batch) return;
		resolveSpine();
		for (const article of batch) if (article.isConnected) processArticle(article);
	}
	function scheduleFullScan() {
		fullScanPending = true;
		queueFrameWork();
	}
	function ownText(article) {
		for (const node of article.querySelectorAll(TEXT_SELECTOR)) if (!node.closest("div[role=\"link\"]")) return node;
		return null;
	}
	function classify(text) {
		if (!text) return "none";
		const chars = (text.textContent ?? "").replace(/\s+/g, "").length;
		const emoji = text.querySelectorAll("img").length;
		if (chars === 0) return emoji > 0 ? "emoji" : "none";
		return chars <= CONFIG.column.shortMaxChars ? "short" : "long";
	}
	function classifyCaption(article) {
		const kind = classify(ownText(article));
		if (article.dataset[CAPTION_ATTR] !== kind) article.dataset[CAPTION_ATTR] = kind;
	}
	function heroPath() {
		const match = STATUS_PATH.exec(location.pathname);
		return match ? match[0] : null;
	}
	function markHero(article, path) {
		if (!path) return;
		let hit = false;
		for (const anchor of article.querySelectorAll("a[href]")) {
			const href = anchor.getAttribute("href");
			if (href && href.split("?")[0] === path) {
				hit = true;
				break;
			}
		}
		if (!hit) return;
		article.dataset[HERO_ATTR] = "1";
		const cell = article.closest(CELL_SELECTOR);
		if (cell) cell.dataset[HERO_CELL_ATTR] = "1";
	}
	function clearHeroMarks() {
		for (const el of document.querySelectorAll("[data-te-hero]")) delete el.dataset[HERO_ATTR];
		for (const el of document.querySelectorAll("[data-te-hero-cell]")) delete el.dataset[HERO_CELL_ATTR];
	}
	function findCarouselHost(list) {
		const stop = list.closest("article");
		let node = list.parentElement;
		for (let depth = 0; node && node !== document.body && node !== stop && depth < HOST_MAX_DEPTH; depth += 1) {
			if (node.offsetWidth >= CONFIG.media.lockWidth && !node.querySelector(TEXT_SELECTOR)) return node;
			node = node.parentElement;
		}
		return null;
	}
	var wiredLists = new WeakSet();
	var indexTargets = new Map();
	var indexFrameQueued = false;
	function updateCarouselIndex(list, host) {
		const tiles = list.children;
		if (tiles.length < 2) return;
		const listRect = list.getBoundingClientRect();
		const rtl = getComputedStyle(list).direction === "rtl";
		let best = 0;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let i = 0; i < tiles.length; i += 1) {
			const rect = tiles[i].getBoundingClientRect();
			const distance = rtl ? Math.abs(rect.right - listRect.right) : Math.abs(rect.left - listRect.left);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = i;
			}
		}
		const label = `${best + 1}/${tiles.length}`;
		if (host.dataset[CAROUSEL_ATTR] !== label) host.dataset[CAROUSEL_ATTR] = label;
	}
	function flushCarouselIndexes() {
		indexFrameQueued = false;
		if (!enabled) {
			indexTargets.clear();
			return;
		}
		const targets = [...indexTargets];
		indexTargets.clear();
		for (const [list, host] of targets) if (host.isConnected) updateCarouselIndex(list, host);
	}
	function scheduleCarouselIndex(list, host) {
		indexTargets.set(list, host);
		if (indexFrameQueued) return;
		indexFrameQueued = true;
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(flushCarouselIndexes);
		else setTimeout(flushCarouselIndexes, FALLBACK_FRAME_MS);
	}
	function markCarousel(article) {
		if (!CONFIG.column.carouselIndex) return;
		const list = article.querySelector(SNAP_SELECTOR);
		if (!list || list.children.length < 2) return;
		const host = findCarouselHost(list);
		if (!host) return;
		if (!wiredLists.has(list)) {
			wiredLists.add(list);
			list.addEventListener("scroll", () => scheduleCarouselIndex(list, host), { passive: true });
		}
		scheduleCarouselIndex(list, host);
	}
	function processArticle(article) {
		classifyCaption(article);
		markHero(article, heroPath());
		markCarousel(article);
	}
	function scanAll() {
		clearHeroMarks();
		resolveSpine();
		const path = heroPath();
		for (const article of document.querySelectorAll(TWEET_SELECTOR)) {
			classifyCaption(article);
			markHero(article, path);
			markCarousel(article);
		}
	}
	function collectArticles(added, into) {
		for (const node of added) {
			if (!node.isConnected) continue;
			if (node.matches?.(TWEET_SELECTOR)) into.add(node);
			else {
				const owner = node.closest?.(TWEET_SELECTOR);
				if (owner) into.add(owner);
			}
			for (const article of node.querySelectorAll?.(TWEET_SELECTOR) ?? []) into.add(article);
		}
	}
	function clearMarks() {
		for (const el of document.querySelectorAll("[data-te-caption],[data-te-hero],[data-te-hero-cell],[data-te-carousel]")) {
			delete el.dataset[CAPTION_ATTR];
			delete el.dataset[HERO_ATTR];
			delete el.dataset[HERO_CELL_ATTR];
			delete el.dataset[CAROUSEL_ATTR];
		}
	}
	var spineResolved = false;
	function resolveSpine(force = false) {
		if (spineResolved && !force) return;
		if (document.documentElement.dataset.teUi !== "on") return;
		const sample = document.querySelector("[data-testid=\"tweetText\"]");
		if (!sample) return;
		const style = getComputedStyle(sample);
		if (!style.maxWidth.endsWith("px")) return;
		const size = Number.parseFloat(style.fontSize);
		const measure = Number.parseFloat(style.maxWidth);
		if (!(size > 0) || !(measure > 0)) return;
		const px = Math.round(measure / size * CONFIG.tweetUi.bodyFontSize);
		if (px <= 0) return;
		document.documentElement.style.setProperty("--te-spine", `${px}px`);
		spineResolved = true;
	}
	function applyTokens() {
		const root = document.documentElement;
		const { column } = CONFIG;
		root.style.setProperty("--te-action-gap", `${column.actionGap}px`);
		root.style.setProperty("--te-caption-emoji-size", `${column.emojiFontSize}px`);
		root.style.setProperty("--te-caption-short-size", `${column.shortFontSize}px`);
	}
	function setEnabled(value) {
		enabled = value;
		document.documentElement.dataset.teColumn = value ? "on" : "off";
		if (value) scheduleFullScan();
		else clearMarks();
	}
	function toggleColumn() {
		setEnabled(!enabled);
		writeFlag("content-column", enabled);
		notifySettingsChanged();
	}
	function enableContentColumn() {
		applyTokens();
		setEnabled(enabled);
		readFlag("content-column").then((stored) => {
			if (stored !== null && stored !== enabled) setEnabled(stored);
		});
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scheduleFullScan, { once: true });
		window.addEventListener("load", scheduleFullScan, { once: true });
		onDomChanged(({ added, overflow: hadOverflow }) => {
			if (!enabled) return;
			if (hadOverflow) {
				scheduleFullScan();
				return;
			}
			if (added.length === 0) return;
			if (!pendingArticles) pendingArticles = new Set();
			collectArticles(added, pendingArticles);
			queueFrameWork();
		});
		document.addEventListener("te:layout", () => {
			if (enabled) {
				resolveSpine(true);
				scheduleFullScan();
			}
		});
		onRouteChanged(() => {
			if (enabled) scheduleFullScan();
		});
		window.addEventListener("load", () => resolveSpine(true), { once: true });
		try {
			document.fonts?.ready?.then(() => resolveSpine(true));
		} catch {}
		registerSetting({
			id: "content-column",
			group: "内容",
			label: "内容列排版",
			description: "正文按内容分层（emoji / 短句 / 长文）、操作栏收进版心、焦点帖加结构分隔",
			isEnabled: () => enabled,
			toggle: toggleColumn
		});
	}
	_css(":root{--te-set-surface:#fff;--te-set-surface-2:#f7f9f9;--te-set-text:#0f1419;--te-set-text-dim:#536471;--te-set-border:#0000001a;--te-set-hover:#0000000a;--te-set-shadow:0 12px 32px #00000029;--te-set-accent:#1d9bf0;--te-set-track-off:#53647166;--te-set-thumb:#fff;--te-set-scrim:#0006;--te-set-fab-bg:#ffffffd9;--te-set-fab-border:#9fb5c3;--te-set-fab-fg:#0f1419;--te-set-fab-shadow:#65778633 0 0 15px 0, #65778626 0 0 3px 1px}html[data-te-theme=dim]{--te-set-surface:#15202b;--te-set-surface-2:#1e2732;--te-set-text:#e7e9ea;--te-set-text-dim:#8b98a5;--te-set-border:#ffffff1f;--te-set-hover:#ffffff0f;--te-set-shadow:0 12px 32px #0000008c;--te-set-track-off:#8b98a580;--te-set-thumb:#f7f9f9;--te-set-scrim:#0000008c;--te-set-fab-bg:#2d2d2dd9;--te-set-fab-border:#fff3;--te-set-fab-fg:#e7e9ea;--te-set-fab-shadow:#00000073 0 0 15px 0, #0000004d 0 0 3px 1px}html[data-te-theme=dark]{--te-set-surface:#000;--te-set-surface-2:#16181c;--te-set-text:#e7e9ea;--te-set-text-dim:#8b98a5;--te-set-border:#ffffff24;--te-set-hover:#ffffff12;--te-set-shadow:0 12px 32px #000000b3;--te-set-track-off:#8b98a580;--te-set-thumb:#f7f9f9;--te-set-scrim:#0009;--te-set-fab-bg:#2d2d2dd9;--te-set-fab-border:#fff3;--te-set-fab-fg:#e7e9ea;--te-set-fab-shadow:#00000073 0 0 15px 0, #0000004d 0 0 3px 1px}.te-settings-fab{z-index:2147483000;box-sizing:border-box;appearance:none;border:1px solid var(--te-set-fab-border);background:var(--te-set-fab-bg);width:55px;height:55px;color:var(--te-set-fab-fg);box-shadow:var(--te-set-fab-shadow);cursor:pointer;border-radius:16px;justify-content:center;align-items:center;margin:0;padding:0;transition:background-color .18s cubic-bezier(.2,0,0,1),color .18s cubic-bezier(.2,0,0,1),transform .18s cubic-bezier(.2,0,0,1);display:flex;position:fixed;bottom:146px;right:20px}.te-settings-fab:hover{color:var(--te-set-accent)}.te-settings-fab:active{transform:scale(.96)}.te-settings-fab:focus-visible{outline:2px solid var(--te-set-accent);outline-offset:2px}.te-settings-fab[aria-expanded=true]{filter:brightness(.94)}.te-settings-fab svg{width:var(--te-set-fab-icon,32px);height:var(--te-set-fab-icon,32px);display:block}.te-settings-overlay{z-index:2147483100;box-sizing:border-box;background:var(--te-set-scrim);backdrop-filter:blur(2px);justify-content:center;align-items:center;padding:24px;display:none;position:fixed;inset:0}.te-settings-overlay[data-te-settings-open=true]{display:flex}.te-settings-dialog{box-sizing:border-box;overscroll-behavior:contain;border:1px solid var(--te-set-border);background:var(--te-set-surface);width:100%;max-width:420px;max-height:min(560px,100vh - 48px);color:var(--te-set-text);text-align:left;box-shadow:var(--te-set-shadow);border-radius:20px;margin:0;padding:20px 20px 14px;font-family:inherit;font-size:15px;line-height:1.4;animation:.16s cubic-bezier(.2,0,0,1) te-settings-in;overflow-y:auto}.te-settings-dialog:focus{outline:none}@keyframes te-settings-in{0%{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}.te-settings-head{justify-content:space-between;align-items:flex-start;gap:12px;display:flex}.te-settings-heading{min-width:0}.te-settings-title{color:var(--te-set-text);margin:0;font-size:18px;font-weight:700;line-height:1.3}.te-settings-sub{color:var(--te-set-text-dim);margin:2px 0 0;font-size:12px}.te-settings-close{box-sizing:border-box;appearance:none;width:32px;height:32px;color:var(--te-set-text-dim);cursor:pointer;background:0 0;border:0;border-radius:999px;flex:none;justify-content:center;align-items:center;margin:0;padding:0;transition:background-color .18s cubic-bezier(.2,0,0,1),color .18s cubic-bezier(.2,0,0,1);display:flex}.te-settings-close:hover{background:var(--te-set-hover);color:var(--te-set-text)}.te-settings-close:focus-visible{outline:2px solid var(--te-set-accent);outline-offset:2px}.te-settings-close svg{width:16px;height:16px;display:block}.te-settings-group{margin-top:16px}.te-settings-group-title{letter-spacing:.02em;color:var(--te-set-text-dim);margin:0 0 4px;font-size:12px;font-weight:600}.te-settings-row{border-radius:12px;justify-content:space-between;align-items:center;gap:16px;margin:0 -8px;padding:8px;transition:background-color .18s cubic-bezier(.2,0,0,1);display:flex}.te-settings-row:hover{background:var(--te-set-hover)}.te-settings-text{flex-direction:column;gap:2px;min-width:0;display:flex}.te-settings-label{color:var(--te-set-text);align-items:center;gap:6px;font-size:14px;font-weight:600;display:flex}.te-settings-desc{color:var(--te-set-text-dim);font-size:12px}.te-settings-kbd{border:1px solid var(--te-set-border);background:var(--te-set-surface-2);color:var(--te-set-text-dim);border-radius:5px;padding:1px 5px;font-family:inherit;font-size:10px;font-weight:500}.te-settings-switch{box-sizing:border-box;appearance:none;background:var(--te-set-track-off);cursor:pointer;border:0;border-radius:999px;flex:none;width:40px;height:22px;margin:0;padding:0;transition:background-color .18s cubic-bezier(.2,0,0,1);position:relative}.te-settings-switch:after{content:\"\";background:var(--te-set-thumb);border-radius:50%;width:18px;height:18px;transition:transform .18s cubic-bezier(.2,0,0,1);position:absolute;top:2px;left:2px;box-shadow:0 1px 2px #00000040}.te-settings-switch[aria-checked=true]{background:var(--te-set-accent)}.te-settings-switch[aria-checked=true]:after{transform:translate(18px)}.te-settings-switch:focus-visible{outline:2px solid var(--te-set-accent);outline-offset:2px}.te-settings-foot{border-top:1px solid var(--te-set-border);color:var(--te-set-text-dim);margin:14px 0 0;padding-top:12px;font-size:11px}@media (prefers-reduced-motion:reduce){.te-settings-dialog{animation:none}.te-settings-fab,.te-settings-close,.te-settings-row,.te-settings-switch,.te-settings-switch:after{transition:none}}");
	var ROOT_CLASS = "te-settings-root";
	var FAB_CLASS = "te-settings-fab";
	var OVERLAY_CLASS = "te-settings-overlay";
	var OPEN_ATTR = "data-te-settings-open";
	var DRAWER_SELECTORS = ["[data-testid=\"GrokDrawer\"]", "[data-testid=\"chat-drawer-root\"]"];
	var LOOK_SOURCE_SELECTORS = ["[data-testid=\"GrokDrawerHeader\"]", "[data-testid=\"chat-drawer-root\"] button"];
	var FAB_MIN_SIZE = 40;
	var FAB_MAX_SIZE = 80;
	var GEAR_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3.2"></circle>
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10.12 3.04V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03z"></path>
  </svg>`;
	var CLOSE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18"></path>
  </svg>`;
	var root = null;
	var fab = null;
	var overlay = null;
	var dialog = null;
	var opened = false;
	var renderedIds = "";
	var resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => anchorFab()) : null;
	var observedDrawers = new Set();
	function whenBody(run) {
		if (document.body) {
			run();
			return;
		}
		document.addEventListener("DOMContentLoaded", run, { once: true });
	}
	function observeDrawers() {
		if (!resizeObserver) return;
		for (const el of observedDrawers) resizeObserver.unobserve(el);
		observedDrawers.clear();
		for (const selector of DRAWER_SELECTORS) {
			const el = document.querySelector(selector);
			if (!el) continue;
			resizeObserver.observe(el);
			observedDrawers.add(el);
		}
	}
	function findLookSource() {
		for (const selector of LOOK_SOURCE_SELECTORS) {
			const el = document.querySelector(selector);
			if (!el || el.tagName !== "BUTTON") continue;
			const rect = el.getBoundingClientRect();
			if (rect.width < FAB_MIN_SIZE || rect.width > FAB_MAX_SIZE) continue;
			if (Math.abs(rect.width - rect.height) > 1) continue;
			if (el.matches(":hover")) continue;
			return el;
		}
		return null;
	}
	function syncFabLook() {
		if (!fab) return;
		const { size, radius, iconSize } = CONFIG.settings.fab;
		fab.style.width = `${size}px`;
		fab.style.height = `${size}px`;
		fab.style.borderRadius = `${radius}px`;
		fab.style.setProperty("--te-set-fab-icon", `${iconSize}px`);
		const source = findLookSource();
		if (!source) return;
		const computed = getComputedStyle(source);
		if (!computed.backgroundColor || computed.backgroundColor === "rgba(0, 0, 0, 0)") return;
		const rect = source.getBoundingClientRect();
		const round = (value) => Math.round(value);
		fab.style.width = `${round(rect.width)}px`;
		fab.style.height = `${round(rect.height)}px`;
		fab.style.borderRadius = computed.borderRadius;
		fab.style.backgroundColor = computed.backgroundColor;
		fab.style.borderWidth = computed.borderTopWidth;
		fab.style.borderStyle = computed.borderTopStyle;
		fab.style.borderColor = computed.borderTopColor;
		fab.style.boxShadow = computed.boxShadow;
		fab.style.color = computed.color;
		const icon = source.querySelector("svg");
		if (icon) {
			const iconRect = icon.getBoundingClientRect();
			if (iconRect.width > 0) fab.style.setProperty("--te-set-fab-icon", `${round(iconRect.width)}px`);
		}
	}
	function anchorFab() {
		if (!fab) return;
		const { right, gap, fallbackBottom } = CONFIG.settings;
		let top = Number.POSITIVE_INFINITY;
		for (const selector of DRAWER_SELECTORS) {
			const el = document.querySelector(selector);
			if (!el) continue;
			const rect = el.getBoundingClientRect();
			if (rect.height <= 0) continue;
			if (rect.top < top) top = rect.top;
		}
		fab.style.right = `${right}px`;
		fab.style.bottom = `${Number.isFinite(top) ? Math.round(window.innerHeight - top + gap) : fallbackBottom}px`;
		syncFabLook();
		observeDrawers();
	}
	function buildFab() {
		const button = document.createElement("button");
		button.type = "button";
		button.className = FAB_CLASS;
		button.title = "页面优化设置";
		button.setAttribute("aria-label", "页面优化设置");
		button.setAttribute("aria-haspopup", "dialog");
		button.setAttribute("aria-expanded", "false");
		button.innerHTML = GEAR_ICON;
		button.addEventListener("click", () => {
			if (opened) closePanel();
			else openPanel();
		});
		return button;
	}
	function buildRow(item) {
		const row = document.createElement("div");
		row.className = "te-settings-row";
		row.dataset.teSetting = item.id;
		const text = document.createElement("div");
		text.className = "te-settings-text";
		const label = document.createElement("span");
		label.className = "te-settings-label";
		label.textContent = item.label;
		if (item.shortcut) {
			const kbd = document.createElement("kbd");
			kbd.className = "te-settings-kbd";
			kbd.textContent = item.shortcut;
			label.appendChild(kbd);
		}
		text.appendChild(label);
		const desc = document.createElement("span");
		desc.className = "te-settings-desc";
		desc.textContent = item.description;
		text.appendChild(desc);
		const toggle = document.createElement("button");
		toggle.type = "button";
		toggle.className = "te-settings-switch";
		toggle.setAttribute("role", "switch");
		toggle.setAttribute("aria-label", item.label);
		toggle.addEventListener("click", () => {
			item.toggle();
			notifySettingsChanged();
		});
		row.appendChild(text);
		row.appendChild(toggle);
		return row;
	}
	function buildBody() {
		const body = document.createElement("div");
		body.className = "te-settings-body";
		const groups = new Map();
		for (const item of getSettings()) {
			let section = groups.get(item.group);
			if (!section) {
				section = document.createElement("section");
				section.className = "te-settings-group";
				const title = document.createElement("h3");
				title.className = "te-settings-group-title";
				title.textContent = item.group;
				section.appendChild(title);
				groups.set(item.group, section);
				body.appendChild(section);
			}
			section.appendChild(buildRow(item));
		}
		return body;
	}
	function renderRows() {
		if (!dialog) return;
		const ids = getSettings().map((item) => item.id).join(",");
		if (ids !== renderedIds) {
			renderedIds = ids;
			const previous = dialog.querySelector(".te-settings-body");
			const body = buildBody();
			if (previous) previous.replaceWith(body);
			else dialog.insertBefore(body, dialog.querySelector(".te-settings-foot"));
		}
		syncRows();
	}
	function syncRows() {
		if (!dialog) return;
		for (const row of dialog.querySelectorAll(".te-settings-row")) {
			const item = getSettings().find((candidate) => candidate.id === row.dataset.teSetting);
			const toggle = row.querySelector(".te-settings-switch");
			if (!item || !toggle) continue;
			const on = item.isEnabled();
			toggle.setAttribute("aria-checked", on ? "true" : "false");
			row.dataset.teSettingState = on ? "on" : "off";
		}
	}
	function buildOverlay() {
		const layer = document.createElement("div");
		layer.className = OVERLAY_CLASS;
		layer.setAttribute(OPEN_ATTR, "false");
		layer.addEventListener("click", (event) => {
			if (event.target === layer) closePanel();
		});
		const box = document.createElement("div");
		box.className = "te-settings-dialog";
		box.setAttribute("role", "dialog");
		box.setAttribute("aria-modal", "true");
		box.setAttribute("aria-labelledby", "te-settings-title");
		box.tabIndex = -1;
		const head = document.createElement("header");
		head.className = "te-settings-head";
		const heading = document.createElement("div");
		heading.className = "te-settings-heading";
		const title = document.createElement("h2");
		title.className = "te-settings-title";
		title.id = "te-settings-title";
		title.textContent = "设置";
		const sub = document.createElement("p");
		sub.className = "te-settings-sub";
		sub.textContent = "Twitter / X 页面优化";
		heading.appendChild(title);
		heading.appendChild(sub);
		const close = document.createElement("button");
		close.type = "button";
		close.className = "te-settings-close";
		close.setAttribute("aria-label", "关闭设置");
		close.innerHTML = CLOSE_ICON;
		close.addEventListener("click", () => closePanel());
		head.appendChild(heading);
		head.appendChild(close);
		const foot = document.createElement("p");
		foot.className = "te-settings-foot";
		foot.textContent = "改动即时生效，并保存在本机（脚本管理器与 localStorage 双写）。";
		box.appendChild(head);
		box.appendChild(foot);
		layer.appendChild(box);
		dialog = box;
		return layer;
	}
	function openPanel() {
		if (!overlay) return;
		renderRows();
		opened = true;
		overlay.setAttribute(OPEN_ATTR, "true");
		fab?.setAttribute("aria-expanded", "true");
		dialog?.focus();
	}
	function closePanel() {
		if (!overlay) return;
		opened = false;
		overlay.setAttribute(OPEN_ATTR, "false");
		fab?.setAttribute("aria-expanded", "false");
		fab?.focus();
	}
	function enableSettingsPanel() {
		const mount = () => {
			if (!root?.isConnected) {
				opened = false;
				root = document.createElement("div");
				root.className = ROOT_CLASS;
				fab = buildFab();
				overlay = null;
				dialog = null;
				root.appendChild(fab);
				document.body.appendChild(root);
			}
			if (!overlay) {
				overlay = buildOverlay();
				root.appendChild(overlay);
				renderRows();
			}
			anchorFab();
		};
		whenBody(mount);
		window.addEventListener("resize", anchorFab);
		onRouteChanged(() => anchorFab());
		document.addEventListener("te:layout", anchorFab);
		onDomChanged(() => {
			if (root && !root.isConnected) mount();
		});
		onSettingsChanged(() => syncRows());
		window.addEventListener("keydown", (event) => {
			if (event.key !== "Escape" || !opened) return;
			event.preventDefault();
			event.stopPropagation();
			closePanel();
		}, true);
	}
	var features = [
		{
			name: "timeline-width",
			enabled: true,
			enable: enableTimelineWidth
		},
		{
			name: "tweet-ui",
			enabled: true,
			enable: enableTweetUi
		},
		{
			name: "sidebar-search",
			enabled: true,
			enable: enableSidebarSearch
		},
		{
			name: "media-cap",
			enabled: true,
			enable: enableMediaCap
		},
		{
			name: "content-column",
			enabled: true,
			enable: enableContentColumn
		},
		{
			name: "settings-panel",
			enabled: true,
			enable: enableSettingsPanel
		}
	];
	startDomWatch();
	startRouteWatch();
	for (const feature of features) {
		if (!feature.enabled) continue;
		try {
			feature.enable();
		} catch (error) {
			console.error(`[twitter-enhancer] 功能 ${feature.name} 启用失败`, error);
		}
	}
})();
