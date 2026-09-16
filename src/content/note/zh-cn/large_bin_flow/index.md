---
title: large_bin_flow
timestamp: 2026-09-16 15:56:00+08:00
toc: true
tags: [PWN/Heap, PWN/Heap/large_bin]
---

# Large Bin 全解：插入 与 取出

> 两大部分合篇：
> **① 插入**——块从 unsorted 被"分发"进 large bin（`_int_malloc`·place chunk in bin）
> **② 取出**——块被 malloc 从 large bin 取走（`_int_malloc`·unsorted 循环之后的两段扫描）
> 基准：glibc 2.23 源码；与《int_malloc_int_free_map》研究地图配套
>
> 另含两个增补：
> **§1.7-1.9** 插入段的【完整执行流程步进版】【实体版对照】【2.30+ 检查挂点】
> **§五** 【large_bin_attack 现场全推演·问答实录】——保留教学问答的全部细节，不压缩、只润色

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

### 0.4 字段偏移速查（全篇换算的依据）

```
【chunk 头视角】                     【用户区指针 p 视角】（p = chunk 头 + 0x10）
  +0x00 prev_size                      （不暴露）
  +0x08 size                           （不暴露）
  +0x10 fd                             p[0]
  +0x18 bk                             p[1]
  +0x20 fd_nextsize                    p[2]
  +0x28 bk_nextsize                    p[3]
```

**由此推出的"写目标换算"**（§五反复用）：

```
写 x->fd          ⇒ 数据落在 x + 0x10
写 x->fd_nextsize ⇒ 数据落在 x + 0x20
（所以"想让写落在目标 T"，就要让 x = T - 偏移：
   T-0x10（fd 偏移）或 T-0x20（fd_nextsize 偏移）——见 §5.4）
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
      victim_index = largebin_index (size);
      bck = bin_at (av, victim_index);   // bck 初始值 = 本 bin 的哨兵头
      fwd = bck->fd;                     // fwd 初始值 = 链首（空 bin 时 == 哨兵头）

      if (fwd != bck) { ...非空：选口子... }
      else
          victim->fd_nextsize = victim->bk_nextsize = victim;   // 自环 = "独苗组首"
```

空 bin 不选口子，收尾四针天然得到 `头 ⇄ victim ⇄ 头`。

### 1.2 短路路径（victim 比"全 bin 最小"还小）

```c
else                              /* large 分发分支（承 §1.0 入口）*/
  {
      victim_index = largebin_index (size);
      bck = bin_at (av, victim_index);        // ← bck 初始值 = 本 bin 的哨兵头
      fwd = bck->fd;                          // ← fwd 初始值 = 链首（空 bin 时 == 哨兵头）

      if (fwd != bck)
        {
          size |= PREV_INUSE;            // 位格式：与链上块字段（bit0=1）对齐后直接比
          if ((unsigned long) (size) < (unsigned long) (bck->bk->size))    // 比"全 bin 最小"
            {
                fwd = bck;                                    // 口子前侧 = 哨兵头
                bck = bck->bk;                                // 旧 bck（哨兵头）->bk = 链尾 = 原最小块
                victim->fd_nextsize = fwd->fd;                // fwd->fd = 链首 max；victim"向小"回绕到 max
                victim->bk_nextsize = fwd->fd->bk_nextsize;   // max->bk_nextsize = 原 min；victim"向大" = 原 min
                fwd->fd->bk_nextsize = victim->bk_nextsize->fd_nextsize = victim;
            }
          else
            { ...下一节：跳组搜索... }
        }
      else
          victim->fd_nextsize = victim->bk_nextsize = victim;
  }
```

- 意义：① 防跳组循环回绕死循环（注释："*if smaller than smallest, **bypass loop below***"）② O(1) 落位（新链尾）
- 环操作 = 重接 `max->bk_nextsize`、`min->fd_nextsize` 两条回绕边 + 给 victim 装两根针

### 1.3 跳组搜索（一般情形）

```c
          else                        /* 一般情形（非短路）：从链首开始跳组 */
            {                         /* 此刻 fwd = 链首（承 §1.0，未被改动）*/
              while ((unsigned long) size < fwd->size)
                {
                    fwd = fwd->fd_nextsize;      // 一次跳一个"组首"（沿环向更小）
                }
```

- 停点 = **第一个 `size ≤ victim` 的组首**；victim ≥ min（1.2 已排除更小）→ 必停

### 1.4 停点判定（两条子路径）

```c
              /* 出跳组循环时：fwd = 停点组首（第一个 size ≤ victim 的组首）*/
              if ((unsigned long) size == (unsigned long) fwd->size)
                  /* Always insert in the second position.  */
                  fwd = fwd->fd;                             // ③a 等大：让位"第二位置"
              else
                {
                    victim->fd_nextsize = fwd;               // ③b 新组首：环 4 针
                    victim->bk_nextsize = fwd->bk_nextsize;  // 读停点的"更大侧回绕"
                    fwd->bk_nextsize = victim;
                    victim->bk_nextsize->fd_nextsize = victim;
                }
              bck = fwd->bk;                                 // 共用：主链口子"后侧"（等大时取让位后的 fwd->bk）
```

- **等大**：victim 进"第二位置"；环字段保持 NULL（身份不变）；`bck` = 原组首
- **更大**：victim 成新组首；`bck` = 停点组首的"更大侧邻居"
- 差别只有一处：**等大动 fwd，更大不动**；`bck = fwd->bk` 置于其后自动各得其位

### 1.5 收尾（所有分支共用）

```c
      /* 此刻（承前面各分支）：fwd / bck = 选好的口子两侧 */
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

### 1.7 完整执行流程（步进版：从头到尾，一步不跳）

> 把 1.0-1.5 拉成一条"从入口到收尾"的完整动线；每步标注 **读什么 / 判什么 / 写什么**——"读"的入口就是攻击面（§五要用）。

**前置（进入插入段之前）**

```
victim 刚从 unsorted 摘下（且非 exact fit）
→ victim_index = largebin_index(victim->size)   【算出来，不是查出来】
→ bck = 哨兵头；fwd = 头->fd（空 bin 时 fwd == 哨兵头）
```

**执行流程树**

```
Step 1  空 bin 判定：fwd != bck ?
        ├─ 空 → 只写自环（victim->fd_nextsize = victim->bk_nextsize = victim）→ 跳到 Step 5
        └─ 非空 ↓

Step 2  位格式 + "比最小"探针：
        size |= PREV_INUSE
        size < bck->bk->size ？            （bck->bk = 链尾 = 全 bin 最小块）
        ├─ 是 → Step 3a（短路路径）
        └─ 否 → Step 3b（跳组搜索）

Step 3a 【短路】victim 是新最小（口子：fwd=哨兵头, bck=原最小）
        环 3 行（重接两条回绕边 + 装 victim 两根针）
        → 跳到 Step 5

Step 3b 【跳组】沿 fd_nextsize 从最大端向小跳：
        while (size < fwd->size) fwd = fwd->fd_nextsize;
        停在"第一个 size ≤ victim 的组首"→ Step 4

Step 4  停点判定（两条子路径）
        ├─ 等大（size == fwd->size）：
        │     fwd = fwd->fd              （让位"第二位置"）
        │     victim 环字段保持 NULL      （不进环）
        │     ——收尾将落在"原组首之后"
        └─ 更大（成新组首）：环 4 针
              victim->fd_nextsize = fwd
              victim->bk_nextsize = fwd->bk_nextsize
              fwd->bk_nextsize = victim
              victim->bk_nextsize->fd_nextsize = victim
        ↓（两路共同后继）
        bck = fwd->bk                     ←★"另一侧邻居"从这里读出，未经验证

Step 5  收尾四针（所有路径共用）：
        mark_bin
        victim->bk = bck;   victim->fd = fwd;
        fwd->bk = victim;   bck->fd = victim;
        → 完成
```

**每步的"读 / 判 / 写"**

| 步 | 读（信任点）| 判 | 写 |
|---|---|---|---|
| 1 | 头->fd | 空否 | 自环 |
| 2 | **victim->size（可被改）**、链尾 size | 比最小 | — |
| 3a | 头->fd、max->bk_nextsize | — | 回绕边 ×2 + victim 两根针 |
| 3b | fwd->size、**fwd->fd_nextsize** | 停点 | — |
| 4 | fwd->size、**fwd->bk_nextsize（可被改）** | 等大否 | 环（或 NULL 保持）|
| 5 | **fwd->bk（可被改）** | — | 四针（写① 环、写② 主链）|

**两条写落地的完整链路**

```
写①（环）  ：victim->bk_nextsize 拷自 fwd->bk_nextsize
            → (它)->fd_nextsize = victim

写②（主链）：bck = fwd->bk
            → bck->fd = victim
```

**一句话总收**

```
插入 = ① 沿 fd 侧"找"（Step 1-4 的搜索/判断）
     + ② 向 bk 侧"要"另一半口子（Step 4→5 的 fwd->bk / fwd->bk_nextsize）
     + ③ 四针"挂"进 [bck, fwd] 之间
攻击改的永远是"② 要来的值"——因为它们被信任、且直接决定写的落点。
```

### 1.8 实体版对照（把代码变量翻译成"你手上的块"）

> 记录一次关键纠偏：只说 `fwd->bk` 是"无法看明白"的——必须回答"**fwd 此刻是哪一个块**"。
> 约定：**R** = 你准备好的块（住在 large bin、能 UAF 改的 resident）；**V** = 你新 free 的块（将被插入的 victim）。

**fwd 是谁（直接回答）**

```
传统打法（2.23-2.29）：fwd = 【你自己 UAF 改过的那块】= R
    ——单块 bin：插入时它必然成为"停点"；
      多块 bin："停点落谁头上"要靠你改 size / 选尺寸来安排

2.30+ 活路：写① 读的是【链首块】（该 bin 链上最大那块）的 bk_nextsize
    ——单块场景 = 你那块；多块场景要认准"链首"这个位置
```

**实体版·完整流程**

```
Step 0  让 R 住进 large bin（free → 消费一次推进去）
Step 1  free V（进 unsorted，等分发）
Step 2  UAF 改【R】：
          R->size         = 视需要（保证插入停点落在 R 上 / 错开"等大"）
          R->bk           = target1 - 0x10
          R->bk_nextsize  = target2 - 0x20
Step 3  触发（一次 malloc 让 V 插入 large bin）——
        插入代码把【R】当邻居，读它的字段：
          读 R->bk_nextsize（= target2-0x20）→ 写：target2 = V
          读 R->bk         （= target1-0x10）→ 写：target1 = V
Step 4  完成：target1、target2 两处 = V 的 chunk 头地址
```

**变量 ↔ 实体 对照表**

| 代码里的符号 | 在这个攻击里，它实际是 |
|---|---|
| `fwd` | **你的 R 块**（插入停点）|
| `fwd->bk` | 你在 UAF 里写的 `target1-0x10` |
| `fwd->bk_nextsize` | 你在 UAF 里写的 `target2-0x20` |
| `bck`（= `fwd->bk` 读出后）| 代码"以为的邻居"——其实就是 `target1-0x10` |
| `victim` | 你新 free 的 V 块 |
| 写值 | V 的 chunk 头地址（glibc 亲手写，你选不了）|

**"这些步骤依据哪一部分代码"**：都出自**同一段**——`_int_malloc` 的 large bin 插入段（"place chunk in bin"），执行时刻 = **V 被分发、插入 large bin 的瞬间**。

```c
else                              /* large 分发分支 */
  {
      victim_index = largebin_index (size);
      bck = bin_at (av, victim_index);
      fwd = bck->fd;                       /* fwd = 链首（单块时 = 你的 R）*/

      if (fwd != bck)
        {
          size |= PREV_INUSE;
          if ((unsigned long) (size) < (unsigned long) (bck->bk->size))
              { ...短路分支... }           /* ← R->size 参与此处判断 */
          else
            {
              while ((unsigned long) size < fwd->size)
                  fwd = fwd->fd_nextsize;  /* ← R->size 参与此处判断 */
              if ((unsigned long) size == (unsigned long) fwd->size)
                  fwd = fwd->fd;           /* ← R->size 参与此处判断 */
              else
                {
                  victim->fd_nextsize = fwd;
                  victim->bk_nextsize = fwd->bk_nextsize;      /* ★读 R->bk_nextsize（L3577）*/
                  fwd->bk_nextsize = victim;
                  victim->bk_nextsize->fd_nextsize = victim;   /* ★写①：target2 = V（L3579）*/
                }
              bck = fwd->bk;                                   /* ★读 R->bk（L3581）*/
            }
        }
      else
          victim->fd_nextsize = victim->bk_nextsize = victim;

      mark_bin (av, victim_index);
      victim->bk = bck;
      victim->fd = fwd;
      fwd->bk = victim;
      bck->fd = victim;                                        /* ★写②：target1 = V（L3592）*/
  }
```

**对应关系表**

| 实体操作（实体版流程）| 源码位置 | 行号（2.23）|
|---|---|---|
| Step 2 改 `R->size` | 被三处判断读：与链尾比 / 跳组循环 / 等大判定 | —（开关）|
| Step 2 改 `R->bk_nextsize` | `victim->bk_nextsize = fwd->bk_nextsize;` → 继而 `…->fd_nextsize = victim` | **L3577 → L3579** |
| Step 2 改 `R->bk` | `bck = fwd->bk;` → 收尾 `bck->fd = victim;` | **L3581 → L3592** |
| Step 3"读 bk_nextsize → 写 target2" | 即 L3577→L3579 两行的连锁 | |
| Step 3"读 bk → 写 target1" | 即 L3581 + 最后一针 `bck->fd = victim` | |

与插入流程步骤编号的对应：

```
Step 3 的"读 R->bk_nextsize → target2"  = ④"更大子分支"里的写①
Step 3 的"读 R->bk → target1"          = ④⑤之间的 bck = fwd->bk ＋ ⑤收尾的最后一针
（而 R->size 是 ②③④ 判定的喂料——所谓"分支开关"）
```

**一句话**：你改的三个字段，恰好是这段代码会"读"的三处；写则发生在读完之后的下游两针——**攻击面 = 代码的读取点**。

### 1.9 版本差异：2.30+ 的两个新检查（挂点定位）

```
2.30+ 在插入段的两个位置钉进检查：

Check1（"更大"子分支内，写①②之间）：
    fwd->bk_nextsize->fd_nextsize != fwd  → "malloc(): largebin double linked list corrupted (nextsize)"
Check2（bck = fwd->bk 之后）：
    bck->fd != fwd                         → "malloc(): largebin double linked list corrupted (bk)"
（"等大"路径走 Check2 也会被拦；参考行：2.35 的 L4133-4134 / L4139-4140）
```

- **两个检查恰好逐一验证"Step 4/5 读取的两个定向字段"**：
  - Check1 读 `fwd->bk_nextsize->fd_nextsize`（即读 **target2 位置**的旧值）；
  - Check2 读 `bck->fd`（即读 **target1 位置**的旧值）。
- **传统打法**（改 bk / bk_nextsize）在此双死——因为伪邻居身上不可能有"正确的回指"。
- **活路**：让 victim "天然比链上最小还小" → 落【比最小还小】分支（该分支**无检查**）：

```
新分支消费的字段是【链首块（fwd->fd）】的 bk_nextsize——
   单块场景与 resident 重合；多块场景要认准"链首"
   条件：victim 比 bin 内最小块还小（"天然小"即可，不必改 size）
   写： (被改值)->fd_nextsize = victim   （单写；无主链那一针）
```

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
/* 此刻 victim = 链首（承 A1 门内 first(bin) 的赋值）*/
victim = victim->bk_nextsize;      // 起点：链首->bk_nextsize = 回绕边 → 最小组首
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
/* 此刻（承 A4 摘除后）：victim = 摘下的块；size = 它的原大小；nb = 请求净大小 */
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

**B1 起步 `++idx`**：

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
8. **哨兵头的物理真相**（§5.10 详述）：它只是 bins 数组里**两个指针槽**（`bins[(i-1)*2]`、`bins[(i-1)*2+1]`）伪装成的块——**没有 fd_nextsize/bk_nextsize 的槽位**；所以"nextsize 环永远绕开它"是结构性的。

---

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

## 五、large_bin_attack 现场全推演（问答实录）

> 这一章是"插入机制在攻击现场的实际运行"的**逐站推演 + 全部追问的忠实记录**（只润色语句，不压缩内容）。
> 视角与《large_bin_attack_walkthrough》互补：walkthrough 是"老 demo 的逐段代码注解"，这里是"机制视角的逐状态推演"。
> 每节保留 **【疑问 → 分析 → 达成理解】** 的推进痕迹——包括当时卡住的点、岔路与修正（以"分析的过程 / 理解轨迹"等标记段出现）。

### 5.0 现场两侧：六块堆布局 + 两个栈目标

```
栈目标： var1 = 0x7fffffffd920   var2 = 0x7fffffffd928

堆布局（chunk 头）：
  0x555555559000  0x430   → p1
  0x555555559430  0x30    → g1
  0x555555559460  0x510   → p2
  0x555555559970  0x30    → g2
  0x5555555599a0  0x510   → p3
  0x555555559eb0  0x30    → g3
```

| 地址 | 名字 | 角色 | 在流程中的命运 |
|---|---|---|---|
| `0x…9000`（0x430）| **p1** | **陪跑/牺牲块** | free 进 unsorted → 中间 malloc 时被分发（进 large bin）→ **随后被段 B 取走切掉**（用 0xa0、剩 0x390 回 unsorted）|
| `0x…9430`（0x30）| **g1** | 隔离带① | 不 free；**防止 p1 与 p2 合并** |
| `0x…9460`（0x510）| **p2** | **resident 块 = "R"**（核心攻击对象）| free 进 unsorted → 中间 malloc 时被分发进 large bin 并**留守**（"就位"）→ **UAF 改它三字段** → 触发时充当 **fwd**，两条写的目标都是从它身上读的 |
| `0x…9970`（0x30）| **g2** | 隔离带② | 不 free；**防止 p2 与 p3 合并** |
| `0x…99a0`（0x510）| **p3** | **victim 块 = "V"**（写值来源）| free 进 unsorted → 触发时被分发、插入 large bin → **它的 chunk 头地址被写进两个栈变量** |
| `0x…9eb0`（0x30）| **g3** | 隔离带③ | 不 free；**防止 p3 与 top 合并**（否则 free(p3) 直接并入 top，"待插入块"就没了）|

一句话读法：

```
p1  = 让 p2 有机会"进 large bin 就位"的陪跑块（自己最终被切）
g×3 = 三道隔离墙——保证每个 free 块"不相邻、不合并"（相邻即合并）
p2  = 被改的块（R）：size=开关、bk/bk_nextsize=弹药
p3  = 被插入的块（V）：写值 = 它的 chunk 头地址
栈  = 两个靶子：0x…d920 接写②、0x…d928 接写①
最终结局预告：var1 = var2 = 0x5555555599a0（= p3 的 chunk 头）
```

两个小注：

1. **p2 与 p3 同为 0x510**——故意的：插入时它们本会"等大"，所以必须**改 p2 的 size 错开**（"分支开关"，§5.8 详述）。
2. 接下来在这张布局上依次做：`free(p1); free(p2)` → 中间消费 → `free(p3)` → UAF 改 p2 → 触发。

### 5.1 从 free 到"上料"：malloc(0x90) 有什么用

**free(p1)、free(p2) 之后**（实测链状态）：

```
unsorted: 0x555555559460 —▸ 0x555555559000 —▸ 0x7ffff7bc4b78 ◂— 0x555555559460

读法（fd 链）：头(0x…4b78) →fd→ p2(0x…9460) →fd→ p1(0x…9000) →fd→ 头
（后 free 的 p2 贴在头侧；bk 链反着来：头 →bk→ p1 →bk→ p2 →bk→ 头）
```

**追问：这一步 malloc(0x90) 有什么用？**——它是整个攻击里最容易被忽略但最要命的一步，干三件事：

**① 真正的作用：让 p2"就位"进入 large bin**

```
free 完只是让 p2 待在 unsorted（候车室）——
但攻击的两个"读取点"（fwd->bk / fwd->bk_nextsize）
只发生在【large bin 插入过程】里。

→ 必须有一次 malloc 做"消费"，把 p2 从 unsorted 推进 large bin。
   （这一步不做，触发时 p2 还在 unsorted，停点根本轮不到它。）
```

**② 清场：顺手把 p1 从 large bin 里"切走"（陪跑块的第二次牺牲）**

```
轮1：p1 被取出【分发】→ 进 large bin（0x430 档）
轮2：p2 被取出【分发】→ 进 large bin（0x510 档）
unsorted 空 → 段 A 跳过（0x90 是 small 请求）→ 段 B：
    从低档扫——先遇到 p1 的档（64 < 68）→ 取 p1 切掉 0xa0 → 返回
    （p2 的档 68 根本没被访问）
```

**为什么要"切走 p1"**：如果连 p1 也留在 large bin 里，large bin 就有了**两个块**——触发时 p3 插入的停点 `fwd` 落谁头上就说不准了；攻击要的是 **large bin 里干干净净只有 p2**（停点板上钉钉 = p2）。

**③ 为什么偏偏是 0x90（这个大小有讲究）**

```
· small 请求 → 才会"跳过段 A、走段 B 切大块"（整条切割路径的入口）
· 且刻意避开两块的大小——
    请求 0x420 会把 p1 直接 exact 拿走
    请求 0x500 会把 p2 直接 exact 拿走（→ R 块直接毁局！）
  0x90 谁都不命中 → 只能走"分发 + 段 B 切割"
```

**执行后你会看到**（对账预测）：

```
large bin：p2（0x555555559460）就位
unsorted ：[ 0x5555555590a0 ]        ← p1 的剩余（0x9000 + 0xa0，size 0x390）
heap     ：p1 头部被改写为 0xa1（用掉的 0xa0 返回给调用者，随即丢弃）
```

**一句话**：

```
这一步 = "上料"：把 R（p2）送进 large bin 摆好，
         同时把碍事的陪跑块 p1 清出场——
         从此 large bin 里只有一个可以被你 UAF 改的块。
```

**分析的过程（补记）**：

```
【起点】free(p1)、free(p2) 后，看到 unsorted 里已经躺了两块——
  容易顺推："p2 已经在链上了，接下来改它就行？"
  ✗ 不对：这个"链"是 unsorted（候车室）；
  攻击的读取点（fwd->bk / fwd->bk_nextsize）只存在于【large bin 插入】的代码里。

【第一跳】必须有一次"消费"把 p2 从 unsorted 推进 large bin——
  这是 malloc(0x90) 的第一重意义（就位）。

【第二跳】为什么还要"切走 p1"？
  —— 若 p1 也留在 large bin，触发时停点 fwd 落谁头上就不确定
  → 清场（large bin 里必须只剩 p2）。

【第三跳】为什么偏偏 0x90？——反例锁死：
  请求 0x420 / 0x500 会把 p1 / p2 直接 exact 拿走（毁局）；
  0x90 谁都不命中 → 只剩"分发 + 段 B 切割"这一条路。
```

**理解轨迹**：从"free 完算不算就位" → "必须消费一次才就位" → "顺带还要清场"——
三步推理，恰好对应 malloc(0x90) 的三重作用。

### 5.2 free(p3) 之后：两张脸就位

```
unsorted: 0x5555555599a0 —▸ 0x5555555590a0 —▸ 0x7ffff7bc4b78 ◂— 0x5555555599a0

p3(0x…99a0)    = 你要插入的 V          ← 写值来源
p2(0x…9460)    = 触发时的 fwd（R）     ← 它不在这个链里，它住在 large bin
p1'(0x…90a0)   = 陪跑块的残躯（0x390）
```

**理解检查**：此刻三块各就各位——p3 = 待插入的 V；p2 = 即将当 fwd 的 R（住在 large bin）；p1' = 陪跑残躯。看到这条链就该条件反射：**牌已经发好，只差"改 R"与"触发"两步。**

### 5.3 关于"切割"的三条追问（实录）

**追问一："切割不应该只发生在 unsorted 里只有一个 chunk 的时候吗？"**

答：那是**其中一种**切割。切割出现在三个场合：

```
a. unsorted 循环内（last remainder 切割）：
     条件苛刻：small 请求 && 【bck == 头（unsorted 里只有它一块）】
               && victim == last_remainder && size > nb + MINSIZE
     ←你们记的"只有一个 chunk 时才切"说的是这个 ✓

b. 段 A（本 bin·large 取出）后的切割

c. 段 B（binmap 扫描）后的切割   ←★ demo 里 p1 的切割是这一种
     —— 从 large bin 里挑块切开，【没有"唯一块"条件】；
        切开后的剩余回插 unsorted（用"完整插入"写法——因为不能假设链空）
```

所以 demo 里 p1 被切，**不是**那个"唯一块"场景——而是**它先住进 large bin，随后被段 B 取出来切的**。

【当时的理解】记忆里的条件"unsorted 里只有一个 chunk 时才切割"本身没错——那是 **unsorted 循环内 last remainder 切割**的条件；但它只是"三种场合之一"，不是"切割的全集"。把三个场合排开，"p1 被切"就归位到"段 B 切割"，矛盾消失。

**追问二："顺序是先 p2 放 large bin、再切 p1 吗？"**

答：顺序要修正——**源码里是先 p1、后 p2**；而且"显示顺序 ≠ 处理顺序"：

```
你看的 0x…9460 —▸ 0x…9000 是【fd 链的排列】（free 时新块贴在头侧）：
fd 链：头 →fd→ p2(0x…9460) →fd→ p1(0x…9000) →fd→ 头     ← 显示就是这样
bk 链：头 →bk→ p1(0x…9000) →bk→ p2(0x…9460) →bk→ 头
取出端 = 头->bk = 【p1（最旧）】——处理从它开始
```

完整时间轴（对这套地址）：

```
轮1：p1（0x…9000）被取出 —— 大小不符合、轮内切割条件不满足
     → 分发 → 进 large bin（0x430 档）
轮2：p2（0x…9460）被取出 —— 同样不符合
     → 分发 → 进 large bin（0x510 档）
（unsorted 空，循环结束——注意：此刻两块都已经不在 unsorted 了）

段 A：跳过（0x90 是 small 请求）
段 B：从低档扫——先遇到 p1 的档（64 < 68）→ 从 large bin 取出 p1 → 切开：
     用掉 0xa0（返回，丢弃）、剩余 0x390 回插 unsorted（头 = 0x5555555590a0）
     → 返回；p2 的档 68 没被碰
```

净效果：p2 留 large bin ✓、p1 被切 ✓——但"p2 先放 large bin、再切 p1"的说法要改成：**"两块都先被分发（p1 先、p2 后），切割发生在【段 B】里——切的时候 p1 已在 large bin"**。

附注：就算把处理顺序换过来，**净效果也会是一样的**（p2 留、p1 被段 B 切）——因为切割总在段 B 发生；但**源码顺序就是"最旧的先"**（bk 端取出），以源码为准记。

【当时的理解】"先 p2 进 large bin、再切 p1"是顺着**显示顺序**顺手推的假设。修正用了两把钥匙：
  ① 显示的是 fd 链（新 free 的块贴在头侧）≠ 处理顺序；
  ② 取出端在 bk（最旧的先取）→ 源码顺序就是 p1 → p2。
另配一颗"安心丸"：就算顺序换过来，净效果也一样（切割总在段 B）——顺序之争论的是叙事过程，不是结局。

**追问三："p1'(0x…90a0) 还会重复被分发、然后被取出吗？"**

答：对，但这次和上次不一样：

```
上次（它还是 p1，0x430）：是 large → 被分发进 large bin → 被段 B 切
这次（它只剩 0x390）：  跌进 small 范围（<0x400）
                        → 会被分发进 small bin（57 档）→ 然后照样被段 B 取出、切一刀
（0x430 − 0xa0 = 0x390——"挨了一刀之后，从大货架跌进小货架"）
```

**触发步的完整时间轴（定死顺序）**：

```
轮1：p1'(0x…90a0) 被取出 → 分发进 small bin（57 档）
轮2：p3(0x…99a0) 被取出 → 分发进 large bin
     ★ 大戏在这里：插入段执行——fwd = p2——两条写落地（或 2.30+ 撞检查）
段B：循环退出后——扫到 small bin 57 → 把 p1' 取出来切 0xa0
     （剩余 0x2f0 回 unsorted）→ 这块被切出来的内存就是 malloc(0x90) 的返回值（被丢弃）
```

注意顺序：**p1' 的"分发"在轮1，但它真正的"被取出（切）"被推迟到了最后一站（段 B）**——中间夹着 p3 的大戏。也就是说：

```
p1' 做两件事：①轮1 腾地方（从 unsorted 挪去 small bin）
             ②段B 当"垫场的"（切一刀把请求喂饱、让 malloc 返回）
     而攻击的核心事件（两写）发生在它俩之间的轮2——不受 p1' 影响。
```

【理解推进】"0x…90a0 还会重复被分发和取出吧？"——直觉对（它会再被处理一次），但最重要的补充是"在哪一步"：**分发在轮1、被切在段 B，大戏（两写）夹在中间**。"它真正的'取出'是全场最后一个动作"——这是最容易排错的时序点。

### 5.4 篡改现场（一）：参数 0x…d910 / 0x…d908 是怎么来的

现场代码（demo 第 96-97 行）：

```c
/* p2 = R 块用户区指针（unsigned long*）；p2[1] = R->bk、p2[3] = R->bk_nextsize（§0.4）*/
p2[1] = (unsigned long)(&stack_var1 - 2);    // R->bk          = 0x…d910
p2[3] = (unsigned long)(&stack_var2 - 4);    // R->bk_nextsize = 0x…d908
```

**换算原理："减掉的数字 = 目标字段的偏移量"**——因为代码往栈上写时，**不是"直接写目标"，而是"把目标当成某个伪块的字段来写"**：

```
写② 落点 = bck->fd   → 写 [bck + 0x10]
   要落到 var1(0x…d920)，就得让 bck = 0x…d920 - 0x10 = 0x…d910
   （一个 unsigned long* 减 2 个元素 = -0x10）✓

写① 落点 = (bk_nextsize)->fd_nextsize → 写 [bk_nextsize + 0x20]
   要落到 var2(0x…d928)，就得让 bk_nextsize = 0x…d928 - 0x20 = 0x…d908
   （减 4 个元素 = -0x20）✓
```

即：**"&var1 - 2" 和 "&var2 - 4" 分别是"把栈地址伪装成伪块的 fd 槽 / fd_nextsize 槽"所需的回退量**。

**追问："写② 是写 fd，为什么不是 -1？"**——把字段偏移钉死（§0.4 表）：

```
写② 落点 = bck->fd = bck + 0x10 → 要落到 var1，需要 bck = var1 - 0x10 = &var1 - 2
（表达式里 -2：因为 &stack_var1 是 unsigned long*，减 1 = 减 8 字节；-0x10 = 减 2 个元素）

如果只减 1（-0x8）：
   bck = var1 - 0x8 = 0x…d918
   bck->fd → [0x…d918 + 0x10] = [0x…d928] = var2   ← 直接窜到隔壁去了
```

数值小账（对照现场地址）：

```
bck = &var1 - 2 = 0x7fffffffd920 - 0x10 = 0x7fffffffd910
bck->fd = *(0x7fffffffd910 + 0x10) = *(0x7fffffffd920) = var1 ★ ✓

（写① 同理：bk_nextsize = &var2 - 4 = 0x…d908；
  ->fd_nextsize = *(0x…d908 + 0x20) = *(0x…d928) = var2 ★）
```

记法：

```
你往 bk 里放的不是"目标"，而是"【目标位置再回退 fd 偏移】"做的伪块指针——
代码会自动 +0x10（写②）/ +0x20（写①）帮你精确命中。
   写②：改 R->bk           = 目标 - 0x10（fd 偏移）
   写①：改 R->bk_nextsize  = 目标 - 0x20（fd_nextsize 偏移）
```

【分析起点】最初的问题是"0x…d910 / 0x…d908 这两个数是怎么来的？"——不是拍脑袋编的：
伪块写 = "先回退字段偏移，再让代码自动前进"——
  写 fd（+0x10）就先退 0x10（&-2）；写 fd_nextsize（+0x20）就先退 0x20（&-4）。
【自校验】用反例锁死量纲：若只减 1（-0x8），落点会窜到隔壁 var2——证明每一格偏移都是精确刻度。

### 5.5 篡改现场（二）："这不是写 bk 吗？为什么会写 fd？"

答：不矛盾——"写 bk"和"写 fd"是**两个不同角色**，排成一条链就顺了：

```
① 你改：   R->bk = var1 - 0x10          ← 你确实在改 bk 字段（埋弹药）
② 代码读： bck = fwd->bk                ← 代码把"你埋在 bk 里的值"读出来当邻居
③ 代码写： bck->fd = victim             ← 真正落地的是"这个伪邻居的 fd 字段"
```

**"改 bk"是为了让代码"读着 bk 去写 fd"**——一个负责"指方向"，一个负责"落笔"。（口诀：**读 bk、写 fd**。）

【当时的疑惑】"这不是写 bk 吗？如果是写 fd 不应该是 -1 吗？"——把**你改的字段（bk）**与**最终被写的字段（fd）**当成了同一个对象。链条一拆就顺：

```
① 改 bk      （埋弹药——你干的）
② 读 bk      （取弹药——bck = fwd->bk）
③ 写 fd      （落笔——bck->fd = victim）
```

"改 bk"与"写 fd"在链条的不同位置，两者都对。

### 5.6 篡改现场（三）：为什么会有"解引用"这一环？

答：因为这段代码的本职是"**维护双向链表**"，而链表的写操作天生只能"顺着指针走"——解引用不是多余环节，它是**链表的物理定律**。

```
任何双向链表的插入，本质三步：
① 找到两个邻居（bck, fwd）
② 把新块自己接上：victim->bk = bck; victim->fd = fwd;
③ 让邻居各指回来：fwd->bk = victim;  bck->fd = victim;   ← 解引用在这里

第③步的字面形态只能是 `邻居->字段 = victim`——
因为"邻居"这个东西，代码手里只有"指针值"：
   bck 从哪来？—— 读 fwd->bk 读出来的（第 1 次"信任"：把字段值当地址）
   写向哪？    —— 拿 bck 的值再解引用（第 2 次"信任"：把取出的值当地址字段用）
```

**它的每一次"写"，地址来源都是"某个字段读出来的值"**——不存在"凭空知道目标地址"的可能。所以：

```
不是你"必须绕一层解引用"——
而是这段代码【只会】通过解引用来找写地址；
你的攻击 = 往"它要读的那个字段"里喂一个假邻居，
           它就会"顺着假指针"把写恭敬地送到你指的地方。
```

**"解引用"就是"信任"的兑现时刻**。

**选针逻辑（为什么是这一针）**：插入时"邻居回指"其实有**两针**：

```
fwd->bk = victim;    ← 落点在真块 fwd 身上（地址 = fwd，你控制不了）
bck->fd = victim;    ← 落点 = bck（地址来自 fwd->bk，你可以控制）★ 攻击选它
```

两针都会执行，但只有"**地址来自可篡改字段**"的那一针可以用来打目标。

一句话收：**"为什么有解引用"和"为什么能攻击"是同一个答案——链表代码只认字段里的指针；它信什么，你就改什么。**

【理解达成（原话复述）】"这仍旧是去写 bck->fd，但是在前面一步的时候，是将 bck 给改写成了 fwd->bk……最后将 victim 写进 fd 跟 fd_nextsize，即将 stack 区伪装成了 victim 的 bck。"——**此总结成立**：伪装的关键就在于让"栈地址-偏移"在代码眼里"像一个邻居块"——它越像，骗得越深。

### 5.7 篡改现场（四）："为什么不像取出时直接确定 fwd 和 bck？"

答：关键在一个词——**身份**。

```
【取出/摘除时】victim 是"链上成员"：
   它的 fd/bk 本来就通向"这条链里的真邻居"
   → 代码直接读它，白得两个邻居：fwd = victim->fd; bck = victim->bk;
   （信息"住在 victim 身上"）

【插入时】victim 是"外来户"：
   它刚从 unsorted 摘下——身上的 fd/bk 是【上一个家的残留】（unsorted 的旧邻居），
   与 large bin 无关。
   → 不是"不想用"，是【用不了】：读它只会拿到另一个链的东西。
   邻居必须去【新链上现找】。
```

外来户的"现找"流程 = "一次取址 + 一次解引用"：

```
第一步（找锚点）：用 size 比较沿链搜索 → 找到一端邻居 fwd
    （为什么搜？因为 large bin 按大小排序，插入必须找到正确位置）

第二步（取地址）：bck = fwd->bk
    —— 这一步不是"读一个普通的值"，而是【向 fwd 领另一端邻居的地址】：
       链表里没有"旁路"，站在 fwd 上想知道"它后面是谁"，只能读它的 bk 字段

第三步（解引用写）：bck->fd = victim
    —— 拿到地址，才能把 victim 交给它（这是此刻"唯一已知的落笔途径"）
```

**信息传递是单向链式的**（"想知道另一头，只能向这一头要"），所以"一读一写"是最短路径，绕不开——而这个"要"字，正是攻击的入口：**要来的地址没人验证**。

**修正一个常见误读**："这个时候可以直接读 victim 中的数据，而这个是可以信任的"——**在插入场景恰恰相反**：

```
插入时读 victim 身上的 fd/bk = 读到"上个家的残留"（垃圾信息，不可信、不可用）
所以插入路径才不得不"搜锚点 → 领地址 → 解引用"三步走
```

（附：unsorted 摘除 victim 时也是"从 victim 读"——因为那一刻它仍是成员 ✓。身份三态：链上成员/外来户/——摘除后带着残留。）

【分析起点】用"取出时直接读 victim"作对照，直觉很好——但两个场景里 victim 的**身份不同**：取出时是"成员"（身上带着本链的真邻居）；插入时是"外来户"（身上是上个家的残留）。
【关键理解】链上信息单向传递（想知道另一头，只能向这一头要）→ "一读一写"是最短路径、绕不开——而攻击就活在这"一读"里：要来的地址没人验证。

### 5.8 "正常情况下，这些值该写进哨兵头吗？"

答：**对一大半**——要把"两针"分开看，且注意正常走的是哪条路径：

**正常时（demo 原样 = 等大路径）：victim 插到头部旁边**

`p3` 与 `R` 等大（都是 0x510），插入走**等大路径**，而且会**让位**：

```
停点 R（单块链，R 既是链首又是链尾）
让位：fwd = R->fd = 【头】        ← fwd 被推成了哨兵头
      bck = 头->bk = R            ← bck 从"头的 bk"取出来（注意：这个值来自哨兵头！）

收尾两针：
   fwd->bk = victim   →  【头->bk = victim】   ★ 写进哨兵头 ✓
   bck->fd = victim   →  R->fd = victim        （落邻居块）
环：不碰（等大不写 fd_nextsize）
```

所以：**"victim 进哨兵头"✓——但只有一针进**；另一针永远落"插口另一侧的邻居块"。

**规律（看插口贴哪边）**：

```
victim 插进 (bck, fwd) 中间——两针各写插口的两侧：
   · 插口贴链头时（本场景）：一侧是哨兵头 → 那一针落哨兵头
   · 另一侧永远是【块】（demo 里是 R）
   · 环（fd_nextsize）由"组首们"组成，【永远不经过哨兵头】
```

若走"新组首"路径（链上多块、victim 成新链首），镜像同样成立：

```
bck = R->bk = 头 → 头->fd = victim ★（进哨兵头）
fwd->bk = victim → R->bk = victim   （邻居块）
```

**顺带解开一个旧挂——"为什么要改 size 错开等大"**：回看等大路径的 `bck = 头->bk`：**bck 是从哨兵头里取的**——哨兵头在 libc 里，**你改不了** → 这针没法用来打目标。

```
等大路径 ：bck 来源 = 头->bk   → 不可控 ✗
新组首路径：bck 来源 = R->bk    → 你的块、可控 ✓ ← 改 size 的真实目的！
```

**"错开等大"不只是"多一针环写"——更是把"落笔地址的来源"从哨兵头手里抢回到你的块身上**。

（附注：若 victim 与 resident "天然不等大"（如 0x420 与 0x500 的组合），则"错开"不需要改 size——**请求 nb 不等于 victim 原 size 时，size 可以不动**。）

【过程回放】"正常时写进哨兵头吗？"（猜测）→ 拆两针、拆两条路径（分析）→ "一针进头、一针进块"（规律）→ 顺带发现"等大不可控、新组首可控"（衍生结论）——一个疑问走了四级台阶，最后一级直接解释了"改 size"的动机。

### 5.9 "那如果不伪装，它是不是就进哨兵头？"

答：对。写② 那针：**是，进哨兵头**。

现场（victim 比 R 大、插到 R 前面）：

```
不伪装时：
    bck = fwd->bk = R->bk = 【哨兵头】   ← 单块链里，R->bk 的真实值就是头
    bck->fd = victim  →  头->fd = victim   ★ 进哨兵头 ✓

伪装就是把 R->bk 的值从"头"换成了"var1-0x10"——
于是这一针本该落进哨兵头的，被改道去了你的栈。
```

（另一针 `bk_nextsize` 不经过头——不伪装时落 R 自己。）

【追问原话】"我就问现在这种情况，如果不是修改了 chunk 做了伪装，他是不是就进了哨兵头？"——直答：**是**（写② 那针）。单针的问题单针答：不伪装时 `bck = R->bk = 头`，这一针本就落进哨兵头；伪装只是把它改道去了栈。

### 5.10 "nextsize 环永远在 bins 中打转，哨兵头里就没有这个字段吧？"

答：对——而且比这更彻底：**哨兵头根本不是一个"完整的块"**。

```
它只是 bin 数组里的【两个指针】假装成块：
    bins[(i-1)*2]   → 当头块的 fd 槽
    bins[(i-1)*2+1] → 当头块的 bk 槽

它"身上"压根没分配 fd_nextsize / bk_nextsize 这两个位置——
硬要读那个地址，读到的是隔壁 bin 的指针（别人的地盘）。
```

所以两条链的圈定范围天然不同：

```
主链环      = 哨兵头 ↔ 各块 ↔ 哨兵头     （头有 fd/bk 槽，参与）
nextsize 环 = 组首块 ↔ 组首块 ↔ …        （头没槽位，环永远绕开它）
```

——这就是"**写② 可以落进哨兵头、写① 永远不落**"的结构性原因：不是代码不想写，是哨兵头根本没有那个字段可写。

验证（pwndbg 里）：把哨兵头块地址 `x/6gx` 打出来——`+0x10/+0x18` 是它的 fd/bk（链在用它），`+0x20/+0x28` 处躺的就是下一个 bin 的头，不是它的字段。

【理解推进（原话）】"因为 nextsize 环永远是在 bins 中打转，哨兵头中就没有这个字段是吧？"——方向正确，再落到物理层：哨兵头只有**两个指针槽**（bins 数组的一对元素），`+0x20/+0x28` 是隔壁 bin 的地盘。至此"写① 永远不进头"有了结构性解释：不是代码不想写，是头没有那个字段可写。

### 5.11 触发步全景时间轴（汇总）

```
触发：一次 malloc(0x90)（原 demo 的触发请求）——

轮1：p1'(0x…90a0) 被取出 → 分发进 small bin（57 档）    （腾地方）
轮2：p3(0x…99a0) 被取出 → 分发进 large bin               ★ 大戏：
        fwd = p2（单块，必然停点）
        读 R->bk_nextsize → 写 target2 = p3
        读 R->bk          → 写 target1 = p3
     （2.30+ 版：改成让 p3 比 p2 更小、只改 bk_nextsize、单写、无检查）
段B：把 p1' 取出切 0xa0（剩 0x2f0 回 unsorted）→ malloc 返回（返回值被丢弃）
```

**结局**：`var1 = var2 = 0x5555555599a0`（p3 的 chunk 头）。

---

（行号引用基于 glibc-2.23 `malloc/malloc.c`；2.30+ 差异见 §1.9；本文为 large bin 插入/取出的机制总篇 + 攻击现场问答实录）
