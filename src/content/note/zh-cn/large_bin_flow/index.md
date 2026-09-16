---
title: large_bin_flow
timestamp: 2026-09-16 10:32:00+08:00
toc: true
tags: [PWN/Heap, PWN/Heap/large_bin, AI]
---

# Large Bin 全解：插入 与 取出

> 两大部分合篇：
> **① 插入**——块从 unsorted 被"分发"进 large bin（`_int_malloc`·place chunk in bin）
> **② 取出**——块被 malloc 从 large bin 取走（`_int_malloc`·unsorted 循环之后的两段扫描）
> 基准：glibc 2.23 源码；与《int_malloc_int_free_map》研究地图配套

---

## 〇、共同基础

### 0.1 两条链

```
一个 large bin（bins 数组的一项 = 一个 size 范围桶）内部：

【fd/bk 主链】所有块，降序（头 → 最大 → … → 最小 → 头）
【fd_nextsize 环】仅"组首"参与，降序成环；各 bin 独立、不跨 bin；环不经过哨兵头
```

| 术语 | 含义 |
|---|---|
| **bin** | bins 数组中的一项（一个 size 范围桶）|
| **size 组** | 同一 bin 内"精确 size 相同"的块集合 |
| **组首** | size 组在主链上最靠 fd 端的块；**唯一在环上的成员** |
| **第二块**（及后续） | 组内其余成员：不进环，nextsize 字段 = NULL |
| **哨兵头** | `bin_at(av, idx)` 取出的"伪 chunk"，两链的锚点 |
| **口子** | `(bck, fwd)`——插入位置的两侧邻居 |

### 0.2 方向学与命名

```c
/* Reminders about list directionality within bins */
#define first(b)     ((b)->fd)      // "前" = fd
#define last(b)      ((b)->bk)      // "后" = bk
```

- **字段**：`fd`（forward）、`bk`（backward）——块身上存的指针
- **变量**：`fwd`/`bck`——操作时"口子两侧"的临时角色指针（随口子选定而不断重新赋值）
- **统一接线四针**（所有双链插入共用）：

```c
victim->bk = bck;    victim->fd = fwd;
fwd->bk = victim;    bck->fd = victim;
```

- **哨兵头**：`bin_at` 用"重定位技巧"把 bins 数组里仅有的 fd/bk 指针伪装成 malloc_chunk 的头。

### 0.3 三条不变量（后文反复用）

```
① 主链方向：头->fd = 最大块；沿 fd 走 size 递减；头->bk = 最小块
② 环方向：  fd_nextsize 向"更小"、bk_nextsize 向"更大"
            回绕边：min->fd_nextsize = max、max->bk_nextsize = min
③ 身份约定：组首在环上（成环互指）｜非组首恒 NULL（不在环）
            维护方式：块"进 unsorted 前"一律清 NULL
            （free / consolidate / 切割 remainder 三路）；
            只有"上环"那一刻才写环值
```

---

## 一、插入（分发）全流程

### 1.0 入口

触发场景：victim 刚从 unsorted 摘下（摘除只动邻居与头），且**非 exact fit**（`size != nb`）。

```c
if (in_smallbin_range (size)) { ...smallbin 分支... }
else
  {
      victim_index = largebin_index (size);   // 算：victim 该去哪个 bin
      bck = bin_at (av, victim_index);        // 哨兵头
      fwd = bck->fd;                          // 链首（空 bin 时 == 哨兵头）
  }
```

### 1.1 空 bin 判定

```c
if (fwd != bck) { ...非空：选口子... }
else
    victim->fd_nextsize = victim->bk_nextsize = victim;   // 自环 = "独苗组首"
```

空 bin 不选口子，收尾四针天然得到 `头 ⇄ victim ⇄ 头`。

### 1.2 短路路径（victim 比"全 bin 最小"还小）

```c
size |= PREV_INUSE;            // 位格式：与链上块字段（bit0=1）对齐后直接比
if ((unsigned long) (size) < (unsigned long) (bck->bk->size))
  {
      fwd = bck;                             // 口子前侧 = 哨兵头
      bck = bck->bk;                         // 口子后侧 = 原最小块
      victim->fd_nextsize = fwd->fd;          // victim 的"向小"回绕到 max
      victim->bk_nextsize = fwd->fd->bk_nextsize;   // victim 的"向大" = 原 min
      fwd->fd->bk_nextsize = victim->bk_nextsize->fd_nextsize = victim;
  }
```

- 意义：① 防跳组循环回绕死循环（注释："*if smaller than smallest, **bypass loop below***"）② O(1) 落位（新链尾）
- 环操作 = 重接 `max->bk_nextsize`、`min->fd_nextsize` 两条回绕边 + 给 victim 装两根针

### 1.3 跳组搜索（一般情形）

```c
while ((unsigned long) size < fwd->size)
  {
      fwd = fwd->fd_nextsize;      // 从最大端出发，一次跳一个"组首"
  }
```

- 停点 = **第一个 `size ≤ victim` 的组首**；victim ≥ min（1.2 已排除更小）→ 必停

### 1.4 停点判定（两条子路径）

```c
if ((unsigned long) size == (unsigned long) fwd->size)
    /* Always insert in the second position.  */
    fwd = fwd->fd;                             // ③a 等大：让位"第二位置"
else
  {
      victim->fd_nextsize = fwd;               // ③b 新组首：环 4 针
      victim->bk_nextsize = fwd->bk_nextsize;
      fwd->bk_nextsize = victim;
      victim->bk_nextsize->fd_nextsize = victim;
  }
bck = fwd->bk;                                 // 共用：主链口子"后侧"
```

- **等大**：victim 进"第二位置"；环字段保持 NULL（身份不变）；`bck` = 原组首
- **更大**：victim 成新组首；`bck` = 停点组首的"更大侧邻居"
- 差别只有一处：**等大动 fwd，更大不动**；`bck = fwd->bk` 置于其后自动各得其位

### 1.5 收尾（所有分支共用）

```c
mark_bin (av, victim_index);
victim->bk = bck;   victim->fd = fwd;
fwd->bk = victim;   bck->fd = victim;
```

### 1.6 分支总表（插入）

| 分支 | 口子 (bck, fwd) | 环操作 | 主链落点 |
|---|---|---|---|
| 空 bin | (哨兵头, 哨兵头) | victim 自环 | 唯一块 |
| 比最小还小 | (原 min, 哨兵头) | 重接回绕边 ×2 | 链尾 |
| 等大 | (原组首, 原组首->fd) | 无（保持 NULL）| "第二位置" |
| 更大（新组首）| (组首邻居, 停点组首) | 4 针接进环 | 组首之前 |

---

## 二、取出全流程

### 2.0 地图

```
（位置：unsorted 循环之后——此时 unsorted 已空手，前面各站也没中）
【段 A · 本 bin 扫描】（仅 large 请求）
  A1 前置门 → A2 搜索 → A3 避组首 → A4 摘除 → A5 收尾
【段 B · 更大 bin 扫描】（所有请求 · binmap 位图）
  B1 ++idx → B2 位图跳空 → B3 取链尾 → B4 摘除 → B5 收尾
【段 C · use_top】（衔接后续站）
```

### 2.A 段 A · 本 bin 扫描

**A0 时机与前提**：unsorted 循环刚跑完；此前 fastbin/smallbin 未中。`idx = largebin_index (nb)` 是进 large 分支时设置的，**全程未被污染**（unsorted 循环里分发的变量是独立的 `victim_index`）。

**A1 前置门**：

```c
if (!in_smallbin_range (nb))
  {
      bin = bin_at (av, idx);
      /* skip scan if empty or largest chunk is too small */
      if ((victim = first (bin)) != bin &&                // 非空？
          (unsigned long) (victim->size) >= (unsigned long) (nb))   // 最大块够大？
        { ...搜索... }
  }
```

- 为什么放"unsorted 循环之后"：循环里**刚分发进来的块**此刻就躺在 bins 里，必须算作候选。
- 链首 = 本 bin 最大块；连它都 < nb → 整档没戏。

**A2 搜索（skip list）**：

```c
victim = victim->bk_nextsize;      // 起点：回绕边 → 最小组首
while (((unsigned long) (size = chunksize (victim)) < (unsigned long) (nb)))
    victim = victim->bk_nextsize;  // 沿"向大"跳组
```

- 停点 = **第一个 `size ≥ nb` 的组首**（best-fit）；前置门保证必停。
- 与插入方向相反：**插入从最大端往小找（下界），取出从最小端往大找（上界）**。

**A3 避组首**：

```c
/* Avoid removing the first entry for a size so that the skip
   list does not have to be rerouted.  */
if (victim != last (bin) && victim->size == victim->fd->size)
    victim = victim->fd;
```

| 情形 | 动作 |
|---|---|
| 组内多成员 | 取**第二块**（组首不动）|
| 组内唯一成员 | 直接取组首（没得选）|
| victim 是链尾 | 第一个条件直接排除 |

- **零代价原理**：第二块的 nextsize = NULL → unlink 宏的环段整段跳过（见 A4）；取组首（唯一）时才付"环重接"的成本。
- 与插入的"第二位置"哲学一致：**组首身份尽量稳定**。

**A4 摘除（unlink 宏）**：

```
① 存邻居：FD = P->fd;  BK = P->bk;
② 主链两针：FD->bk = BK;  BK->fd = FD;
    └ 校验：FD->bk != P || BK->fd != P → "corrupted double-linked list"
③ 环门：!small(P) && P->fd_nextsize != NULL ？
    ├ 否（第二块）→ 结束（零环代价）
    └ 是（P 在环上）↓
④ 环段：校验 P->fd_nextsize->bk_nextsize != P || ... → "…(not small)"
    ├ FD 是同组第二块（不在环上）→ 扶正：FD 接管环位
    └ 否则（FD 为另一组组首等）→ 常规脱环：P 的两个环邻居互接
```

- **取出路径只会遇到**：第二块（豁免，①②即完）或 组首·唯一成员（② + ④ 常规脱环）。
- "扶正"分支主要给"组首被其他路径（合并/realloc）取走"兜底。

**A5 收尾（exhaust / split）**：

```c
remainder_size = size - nb;

/* Exhaust：余量 < MINSIZE，整块给 */
if (remainder_size < MINSIZE)
  {
      set_inuse_bit_at_offset (victim, size);   // 通知后邻：你前邻被用了
  }
/* Split：切出 remainder 回 unsorted */
else
  {
      remainder = chunk_at_offset (victim, nb);
      /* We cannot assume the unsorted list is empty and therefore
         have to perform a complete insert here.  */
      bck = unsorted_chunks (av);  fwd = bck->fd;
      if (fwd->bk != bck)
          errstr = "malloc(): corrupted unsorted chunks";      // ← 检查
      remainder->bk = bck;  remainder->fd = fwd;
      bck->fd = remainder;  fwd->bk = remainder;
      if (!in_smallbin_range (remainder_size))
        { remainder->fd_nextsize = NULL; remainder->bk_nextsize = NULL; }   // 新块身份
      set_head (victim, nb | PREV_INUSE | ...);
      set_head (remainder, remainder_size | PREV_INUSE);
      set_foot (remainder, remainder_size);     // "脚"：写进下一块的 prev_size
  }
return p;
```

- **"不能假设 unsorted 空"的真相**：unsorted 循环有迭代上限——`#define MAX_ITERS 10000; if (++iters >= MAX_ITERS) break;`——可能带着"没消化完的链"提前退出，所以 remainder 回插必须用"完整插入"（对比：循环内部切割可证"只有 victim 一块"，用双指头简写）。
- remainder 若 large → 清 nextsize（"进 unsorted 前清 NULL"三路之一）。

### 2.B 段 B · 更大 bin 扫描（binmap）

**B1 起步 \`++idx\`**：

```c
++idx;                          // 本档刚查过（段 A）——注释："starting with next largest bin"
```

- **段 B 服务所有请求**（含 small 请求——此时 idx = smallbin_index(nb)，段 A 被跳过，段 B 从"更大的 bin"里找块来切）。

**B2 位图跳空**：

```c
block = idx2block (idx);  map = av->binmap[block];  bit = idx2bit (idx);
for (;;)
  {
      if (bit > map || bit == 0)
        { do { if (++block >= BINMAPSIZE) goto use_top; } while ((map = av->binmap[block]) == 0); ... }
      while ((bit & map) == 0) { bin = next_bin (bin); bit <<= 1; }
      ...
  }
```

- binmap = "哪些 bin 非空"的位图（block/bit 两级扫描）——**跳空 bin 的高速公路**。

**B3 取块**：

```c
victim = last (bin);            // 链尾 = 该 bin 最小块
if (victim == bin) { ...清位（假警报）, 继续... }
else {
    /* 更大 bin 全员 ≥ nb → 链尾天然是最优 */
    assert ((unsigned long) (size) >= (unsigned long) (nb));
    ...unlink...   // 同 A4
}
```

**B4 摘除**：同上（unlink）。

**B5 收尾**：与 A5 **同构**，仅两处差异：

```
① 检查名："malloc(): corrupted unsorted chunks 2"（段 A 是不带 2 的版本）
② 多一行 "advertise as last remainder"：
   if (in_smallbin_range (nb)) av->last_remainder = remainder;
   （段 A 只服务 large 请求，此行永不触发所以没写；段 B 服务 small 请求才有意义）
```

### 2.C 段 C · use_top

两段都没命中 → `use_top:` 从 top 切割（注释：top 视为"因可扩展而最不贴合"的候选）；top 也不足 → `sysmalloc`。

---

## 三、关键细节速查

1. **NULL 约定**：非组首的 nextsize 恒 NULL。来源：free（L4037）/ consolidate（L4193）/ remainder（三处）→ "进 unsorted 前一律清"；用途：unlink 判"是否在环"、扶正判 FD、调试断言。
2. **位格式**：链上块 size 字段 bit0=1（free 块前邻必在用）；`size |= PREV_INUSE` 对齐格式省掩码；`NON_MAIN_ARENA` 断言保证 bit2 不污染。
3. **双向防死循环**：插入的"短路分支"（防跳组绕环）与取出的"前置门"（防搜索跑飞）互为镜像。
4. **变量复用**：fwd/bck 是"口子角色"；`idx`（请求档）与 `victim_index`（分发目标档）是不同变量。
5. **MINSIZE 分界**：exhaust/split 的分界 0x20；来源 `#define MIN_CHUNK_SIZE (offsetof (struct malloc_chunk, fd_nextsize))`。
6. **MAX_ITERS**：unsorted 循环的 10000 次上限——"cannot assume empty"的真相。
7. **组首三思**：插入"不进第一位置"、取出"不取组首"——环重排（reroute）成本；第二块/新块都以 NULL 或"第二位置"与环保持距离。

## 四、镜像对照

### 4.1 插入 vs 取出

| 维度 | 插入（分发）| 取出 |
|---|---|---|
| 搜索方向 | 从最大端往小（找"≤ me"的界）| 从最小端往大（找"≥ nb"的界）|
| 处理组首 | 不抢组首（第二位置）| 不动组首（取第二块）|
| 环操作 | 3 针 / 4 针 / 自环 | 豁免（NULL）或 脱环（两针）|
| 收尾 | 四针 | exhaust / split（+回插检查）|

### 4.2 无序 vs 有序

| | 无序 bin（unsorted / small）| 有序 bin（large）|
|---|---|---|
| 口子 | 固定 (哨兵头, 头->fd) | 按 size 选区（空/尾端/组首前）|
| 插入 | 零判断 + 四针 | 选口子 + 环操作 + 四针 |
| 取出 | 直接拿链尾（small 另有一致性检查）| 段 A（环搜索）+ 段 B（binmap）|

---

（行号引用基于 glibc-2.23 `malloc/malloc.c`；本文为 large bin 插入/取出的机制总篇）
