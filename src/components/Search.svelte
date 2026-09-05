<script lang="ts">
import Icon from "$components/Icon.svelte";

let open = $state(false);
let query = $state("");
let results: { url: string; title: string; excerpt: string }[] = $state([]);
let loading = $state(false);
let error = $state(false);
let timer: ReturnType<typeof setTimeout>;

async function doSearch(q: string) {
	if (!q.trim()) {
		results = [];
		return;
	}
	loading = true;
	error = false;
	try {
		const pf = await import(/* @vite-ignore */ "/notes/pagefind/pagefind.js");
		const search = await pf.search(q.trim());
		const items = await Promise.all(
			search.results.slice(0, 8).map(async (r: any) => {
				const d = await r.data();
				return {
					url: "/notes" + d.url, // 子路径前缀（手动拼接，不依赖 API 选项）
					title: d.meta?.title || d.url,
					excerpt: (d.excerpt || "").replace(/<[^>]+>/g, "").slice(0, 120)
				};
			})
		);
		results = items;
	} catch {
		results = [];
		error = true;
	}
	loading = false;
}

function onInput(e: Event) {
	query = (e.target as HTMLInputElement).value;
	clearTimeout(timer);
	timer = setTimeout(() => doSearch(query), 300);
}
</script>

<button class="inline-flex" aria-label="搜索" title="搜索" onclick={() => (open = true)}>
	<Icon name="lucide--search" />
</button>

{#if open}
	<div
		class="fixed inset-0 z-300 flex items-start justify-center pt-[12vh] px-4"
		onclick={(e) => {
			if (e.target === e.currentTarget) open = false;
		}}
	>
		<div class="w-[min(92vw,640px)] bg-background border border-weak rounded-lg shadow-xl flex flex-col overflow-hidden">
			<div class="flex items-center gap-2 p-3 border-b border-weak">
				<Icon name="lucide--search" />
				<input
					type="text"
					placeholder="搜索文章、随笔…"
					class="grow bg-transparent outline-none"
					autofocus
					oninput={onInput}
					value={query}
				/>
				<button aria-label="关闭" onclick={() => (open = false)}><Icon name="lucide--x" /></button>
			</div>

			<div class="max-h-[60vh] overflow-y-auto p-2 flex flex-col gap-1">
				{#if loading}
					<div class="p-4 text-center text-secondary text-sm">搜索中…</div>
				{:else if error}
					<div class="p-4 text-center text-secondary text-sm">搜索暂不可用（上线部署后生效）</div>
				{:else if query && results.length === 0}
					<div class="p-4 text-center text-secondary text-sm">没有找到结果</div>
				{:else}
					{#each results as r (r.url)}
						<a href={r.url} class="flex flex-col gap-0.5 p-2 rounded hover:bg-weak" onclick={() => (open = false)}>
							<span class="font-semibold text-sm">{r.title}</span>
							{#if r.excerpt}<span class="text-xs text-secondary">{r.excerpt}</span>{/if}
						</a>
					{/each}
				{/if}
			</div>
		</div>
	</div>
{/if}
