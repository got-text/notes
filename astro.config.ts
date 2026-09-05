// @ts-check
import { defineConfig, fontProviders } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import yaml from "@rollup/plugin-yaml";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import svelte from "@astrojs/svelte";
import tailwindcss from "@tailwindcss/vite";
import swup from "@swup/astro";

import GFM from "remark-gfm";
import ins from "remark-ins";
import mark from "remark-flexible-markers";
import spoiler from "@tuyuritio/remark-spoiler";
import CJK from "remark-cjk-friendly";
import CJKStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import ruby from "@tuyuritio/remark-ruby";
import attr from "@tuyuritio/remark-attribute";
import math from "remark-math";
import gemoji from "remark-gemoji";
import footnote from "remark-footnotes-extra";
import abbr from "@tuyuritio/remark-abbreviation";
import { remarkExtendedTable as table, extendedTableHandlers as tableHandler } from "remark-extended-table";
import alerts from "@tuyuritio/remark-github-alert";
import { rehypeHeadingIds as ids } from "@astrojs/markdown-remark";
import anchor from "rehype-autolink-headings";
import links from "rehype-external-links";
import katex from "rehype-katex";
import figure from "@tuyuritio/rehype-image-figure";
import wrapper from "@tuyuritio/rehype-table-wrapper";
import sectionize from "@hbsnow/rehype-sectionize";
import copy from "@tuyuritio/shiki-code-copy";

import reading from "./src/lib/reading";

import siteConfig from "./site.config";
import ZeoSevenFonts from "./src/fonts/zeo-seven-fonts";

// https://astro.build/config
export default defineConfig({
	site: "https://got-text.github.io",
	base: "/notes/", // 子路径部署（门厅将来占根域名）
	trailingSlash: "never",
	i18n: {
		...siteConfig.i18n,
		routing: {
			redirectToDefaultLocale: false,
			prefixDefaultLocale: false
		}
	},
	markdown: {
		// Astro 6.4+ 新写法：插件统一放进 unified()，消除 deprecated 警告
		processor: unified({
			remarkPlugins: [
				[GFM, { singleTilde: false }],
				ins,
				mark,
				spoiler,
				CJK,
				[CJKStrikethrough, { singleTilde: false }],
				ruby,
				attr,
				math,
				gemoji,
				footnote,
				abbr,
				[table, { colspanWithEmpty: true }],
				[alerts, { typeFormat: "capitalize" }],
				reading
			],
			remarkRehype: {
				footnoteLabel: null,
				footnoteLabelTagName: "p",
				footnoteLabelProperties: {
					className: ["hidden"]
				},
				handlers: {
					...tableHandler
				}
			},
			rehypePlugins: [
				ids,
				[anchor, { behavior: "wrap" }],
				[links, { target: "_blank", rel: ["nofollow", "noopener", "noreferrer"] }],
				katex,
				figure,
				wrapper,
				sectionize
			],
			smartypants: false
		}),
		// shikiConfig 保留在顶层（它是语法高亮配置，不在弃用范围内）
		shikiConfig: {
			themes: {
				light: "github-light",
				dark: "dark-plus"
			},
			transformers: [copy({ duration: 1500 })]
		}
	},
	vite: {
		// @ts-expect-error
		plugins: [yaml(), tailwindcss()]
	},
	integrations: [
		svelte(),
		mdx(),
		sitemap(),
		swup({
			globalInstance: true,
			preload: false,
			smoothScrolling: false,
			progress: true
		})
	],
	fonts: [
		{
			name: "Noto Serif",
			provider: fontProviders.google(),
			weights: [400, 700],
			optimizedFallbacks: false,
			fallbacks: ["Noto Serif", "Georgia", "Times New Roman", "serif"],
			cssVariable: "--font-noto-serif"
		},
		{
			name: "Noto Serif SC",
			provider: fontProviders.google(),
			weights: [400, 700],
			optimizedFallbacks: false,
			fallbacks: ["Noto Serif SC", "Source Han Serif SC", "STSong", "Songti SC", "SimSun", "serif"],
			cssVariable: "--font-noto-serif-sc"
		},
		{
			name: "Noto Serif JP",
			provider: fontProviders.google(),
			weights: [400, 700],
			optimizedFallbacks: false,
			fallbacks: ["Noto Serif JP", "Source Han Serif JP", "Hiragino Mincho ProN", "MS Mincho", "serif"],
			cssVariable: "--font-noto-serif-jp"
		},
		{
			name: "Playwrite MX",
			provider: fontProviders.google(),
			weights: [100],
			display: "block",
			subsets: ["fallback"],
			fallbacks: ["Apple Chancery", "Segoe Script", "cursive"],
			cssVariable: "--font-playwrite-mx"
		},
		{
			name: "Maple Mono NF CN",
			provider: ZeoSevenFonts(),
			optimizedFallbacks: false,
			fallbacks: [
				"Maple Mono NF CN",
				"Maple Mono NF",
				"Maple Mono CN",
				"Maple Mono",
				"Consolas",
				"Monaco",
				"Cascadia Code",
				"Courier New",
				"monospace"
			],
			cssVariable: "--font-maple-mono-nf-cn"
		},
		{
			name: "The Peak Font Plus",
			provider: ZeoSevenFonts(),
			optimizedFallbacks: false,
			fallbacks: ["Georgia", "STSong", "serif"],
			cssVariable: "--font-the-peak-font-plus"
		}
	]
});
