import siteConfig from "./src/lib/config";

const config = siteConfig({
	title: "拾光——光阴似幻|赤心犹在",
	prologue: "听风雪喧嚷，看流星在飞翔。我心向我呼唤，去动荡的远方…………",
	author: {
		name: ".Gt邱炎",
		email: "||||||||||||||||",
		link: "||||||||||||||||"
	},
	description: "计算机 · PWN · Re —— 在时光中拾取技术的光",
	copyright: {
		type: "CC BY-NC-ND 4.0",
		year: "2026"
	},
	timezone: "Asia/Shanghai",
	i18n: {
		locales: ["zh-cn"],
		defaultLocale: "zh-cn"
	},
	pagination: {
		note: 10,
		jotting: 24
	},
	heatmap: {
		unit: "day",
		weeks: 20
	},
	feed: {
		section: "*",
		limit: 20
	},
	latest: "*"
});

export const monolocale = Number(config.i18n.locales.length) === 1;

export default config;
