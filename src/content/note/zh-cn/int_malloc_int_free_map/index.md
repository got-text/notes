---
title: int_malloc_int_free_map
timestamp: 2026-09-15 17:02:00+08:00
toc: true
tags: [PWN/Heap, PWN/Heap/malloc_free, AI]
---
# 研究地图：`_int_malloc` × `_int_free`

## 1. `_int_malloc`（取块流程）

- [x] ⓪ 入口：计算 `nb`
	> `request2size` 把请求大小对齐成 chunk 大小；2.26+ 起先看一眼 `tcache`
- [x] ① `fast_bin` 站
	> 请求落在 `fast_bin` 范围且对应 `fast_bin` 非空时，从单链头部取块（`LIFO`）；取出前校验块仍在正确的 size 档，否则报 `malloc(): memory corruption (fast)`。
- [ ] ② `small_bin` 站
	> 从对应 `small_bin` 的链尾取块（"插头取尾"）；摘除前校验 `bck->fd == victim`（`malloc(): smallbin double linked list corrupted`）；取出后设置后邻块的 `inuse` 位
- [ ] ③ `large` 请求提前 `consolidate`
	> `large` 请求发现 `fast_bin` 非空时，先把 fastbin 归并一遍，再进入后续站点。
- [ ] ④ `unsorted` 循环（核心）
	> 从 `unsorted` 链尾逐个取块：`exact` 直接返回、可切割则切（`last_remainder`）、否则分发进 `small` / `large_bin`
	- [x] 4.1 取出块合法性
		> 块的 `size` 必须落在 `(2*SIZE_SZ, system_mem]` 内，否则报 `malloc(): memory corruption`。
	- [x] 4.2 解链维护
		> 摘下 victim 的摘除两针：`头->bk = bck; bck->fd = 头`
	- [x] 4.3 exact fit
		> `size == nb` 直接返回（最快出口）。
	- [ ] 4.4 切割 + `last_remainder`
		> 四条件成立时切割（`small` 请求 / 链上唯一块 / 是 `last_remainder` / 剩余 > `MINSIZE`）；余块回插成为新的 `last_remainder`
	- [x] 4.5 `small` 分发
		> 块进 smallbin：四针插到"头端"。
	- [x] 4.6 `large` 分发插入
		> 空 → 短路 → 跳组 → 停点 → 收尾四针（详见《`large_bin_insert`》）。
- [x] ⑤ 本 `bin·large` 取出
	> 沿 `nextsize` 环从最小组首向大找"第一个 ≥ `nb`"；避组首取第二块；unlink 时同步校验/修复环。
- [x] ⑥ 更大 `bin·large` 取出
	> 用 `binmap` 位图跳过空 `bin`，取最小非空更大 `bin` 的链尾（`best-fit`）。
- [ ] ⑦ `use_top`
	> 各 `bin` 都不行时从 `top` 切割；`top` 被视为"最不贴合的候选"。
- [ ] ⑧ `sysmalloc`
	> `top` 也不够时向系统要内存（`brk` / `mmap`）。
- [ ] ⑨ `tcache` 线（2.26+）
	> `tcache` 的插队与 `stash` 机制（待细分）。

## 2. `_int_free`（还块流程）

- [x] ⓪ 入口检查
	> 指针越界/未对齐报 `free(): invalid pointer`；size 非法的报 `free(): invalid size`。
- [x] ① `fast_bin` 分支（`size` ≤ `max_fast`）
	> 检查 `next` 块 `size`（`invalid next size (fast)`）→ `double_free` 检查（`(fast_top)`）→ 插到链头 → 直接返回，不进 `unsorted`。
- [x] ② 轻量测试组（常规路径入口）
	> `free_top` 本身 → `(top)`；`next` 越过 `top` → `(out)`；`next` 已空闲 → `(!prev)`；`next_size` 非法 → `invalid_next_size (normal)`。
- [x] ③ `consolidate backward`
	> `P` 位为 `0` 时与前块合并：读 `prev_size`、`size +=`、`unlink` 前块；`2.26+` 校验 `corrupted size vs. prev_size`。
- [ ] ④ `consolidate forward` / `top` 合并
	> `next` 空闲则 `unlink` 并合并；`next` 在用则清其 `P` 位；`next` == `top` 时并入 top。
- [x] ⑤ 放置 `unsorted`
	> 插入 `unsorted` 头端（四针）；插前校验 `corrupted unsorted chunks`；`large` 块顺手清空 `nextsize` 字段。
- [ ] ⑥ 后置
	> 大块（`≥64KB`）`free` 会触发一次 `consolidate`；结束后随 `arena` 收尾。
- [ ] ⑦ `mmap` 分支
	> mmap 块由 `__libc_free` 层直接 `munmap`，不走 `_int_free` 主体。
- [ ] ⑧ 非主 `arena`
	> 多线程场景下的 `arena` 归属与锁定。

## 3. 镜像对照（参考）

| 维度 | `_int_free`（放入）| `_int_malloc`（取出）|
|---|---|---|
| fastbin | 插头（`p->fd = *fb; *fb = p`）| 取头 → **LIFO** |
| unsorted | 插头端（fd 侧）| 取尾端（bk 侧）→ 近似 FIFO |
| 放置公式 | 四针（默认口子 = 头端）| 四针（large 需先选口子）|
| 摘除公式 | 合并时 unlink（两针 + 环修复）| 取出时 unlink（同）|
| 报错前缀 | `free():` / `double free or corruption` | `malloc():` |

## 4. 报错家族总表（参考 · 2.23 全量）

**free 侧（10）**

```
free(): invalid pointer                 L3864
free(): invalid size                    L3875
free(): invalid next size (fast)        L3912
double free or corruption (fasttop)     L3937
invalid fastbin entry (free)            L3952
double free or corruption (top)         L3973
double free or corruption (out)         L3981
double free or corruption (!prev)       L3987
free(): invalid next size (normal)      L3995
free(): corrupted unsorted chunks       L4030
```

**malloc 侧（5）**

```
malloc(): memory corruption (fast)                L3385
malloc(): smallbin double linked list corrupted   L3419
malloc(): memory corruption                       L3475  （unsorted 取出块合法性）
malloc(): corrupted unsorted chunks               L3642  （本 bin 取出·切割 remainder 回插）
malloc(): corrupted unsorted chunks 2             L3749  （binmap 段切割 remainder 回插）
```

**通用 / 相邻**

```
corrupted double-linked list              L1418
corrupted double-linked list (not small)  L1427
munmap_chunk(): invalid pointer           L2843
realloc(): invalid pointer                L3014
realloc(): invalid next size              L4267
```
