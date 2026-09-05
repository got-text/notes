import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";
import { z } from "astro/zod";

/**
 * Note collection configuration
 * Represents main blog articles with comprehensive metadata
 */
const note = defineCollection({
	// Load all markdown files except those starting with underscore (private/draft files)
	loader: glob({ pattern: ["**/*.md", "!**/_*.md", "!**/_*/*.md"], base: "./src/content/note" }),
	schema: z.object({
		title: z.string(), // Post title (required)
		timestamp: z.date(), // Publication date (required)
		series: z.string().optional(), // Series name for grouped posts
		tags: z.array(z.string()).optional(), // Array of topic tags
		description: z.string().optional(), // Post description/excerpt
		sensitive: z
			.union([z.boolean(), z.enum(["true", "false"])])
			.default(false)
			.transform(v => v === true || v === "true"), // Marks content as sensitive
		toc: z
			.union([z.boolean(), z.enum(["true", "false"])])
			.default(false)
			.transform(v => v === true || v === "true"), // Whether to show table of contents
		top: z.number().int().nonnegative().default(0), // Top priority for sorting (higher is more important)
		draft: z
			.union([z.boolean(), z.enum(["true", "false"])])
			.default(false)
			.transform(v => v === true || v === "true") // Draft status (excludes from public listing)
	})
});

/**
 * Jotting collection configuration
 * Represents shorter posts, quick thoughts, or micro-blog entries
 */
const jotting = defineCollection({
	// Load all markdown files except those starting with underscore
	loader: glob({ pattern: ["**/*.md", "!**/_*.md", "!**/_*/*.md"], base: "./src/content/jotting" }),
	schema: z.object({
		title: z.string(), // Jotting title (required)
		timestamp: z.date(), // Publication date (required)
		tags: z.array(z.string()).optional(), // Array of topic tags
		description: z.string().optional(), // Brief description
		sensitive: z
			.union([z.boolean(), z.enum(["true", "false"])])
			.default(false)
			.transform(v => v === true || v === "true"), // Marks content as sensitive
		top: z.number().int().nonnegative().default(0), // Top priority for sorting (higher is more important)
		draft: z
			.union([z.boolean(), z.enum(["true", "false"])])
			.default(false)
			.transform(v => v === true || v === "true") // Draft status
	})
});

/**
 * Preface collection configuration
 * Represents introductory content, site announcements, or special pages
 */
const preface = defineCollection({
	// Load all markdown files
	loader: glob({ pattern: "**/*.md", base: "./src/content/preface" }),
	schema: z.object({
		timestamp: z.date(), // Creation timestamp
		// featured: true 的序文会作为"序言"显示在主页（最新的 featured 一篇）
		featured: z
			.union([z.boolean(), z.enum(["true", "false"])])
			.default(false)
			.transform(v => v === true || v === "true")
	})
});

/**
 * Information collection configuration
 * Represents static content like about pages, policies, or site information
 */
const information = defineCollection({
	// Load both markdown and YAML files for mixed content types
	loader: glob({ pattern: "**/*.{md,mdx,yaml}", base: "./src/content/information" })
});

export const collections = { note, jotting, preface, information };
