---
title: overlapping_chunks_family
timestamp: 2026-10-09 23:52:00+08:00
toc: true
tags: [PWN/Heap, PWN/Heap/overlapping，AI]
---

# overlapping 系列总结（`size` 篡改方向）

> 覆盖 `overlapping_chunks` 、 `overlapping_chunks_2` 与 `poison_null_byte` 三个手法。
> 三者的共同目标均为构造 `chunk` 重叠，区别在于篡改的方向（改大 / 改小）与利用的时机。

---

## 一、两条路线

- 改大：将 `size` 字段覆写为更大的值，使后续的取出与合并按放大后的边界进行，直接跨越相邻 `chunk` 。需要非零写入， `off_by_null` 无法完成。
- 改小：将 `size` 字段缩小，本身不引入越界；其作用是使拆分后 `set_foot` 的写入位置前移，保护下一个 `chunk` 的 `prev_size` 旧值，供 `consolidate_backward` 回溯使用。
- `off_by_null` 对 `size` 低字节的作用为缩小与清标志位；对 `prev_size` 字段的作用为改变回溯距离。
- 两者对写原语的要求不同：改大需要非零写入，改小仅需 `off_by_null` 。

---

## 二、`overlapping_chunks`（改大 · 取出环节）

- 前置条件：存在 `UAF` 后写或堆溢出，目标 `chunk` 已释放、其 `size` 字段可被覆写。
- 流程：
	1. `free(p2)` ，使 `p2` 进入 `unsorted_bin` ；
	2. 将 `p2.size` 由 `0x101` 覆写为 `0x181` ；
	3. `malloc(0x178)`（ `nb = 0x180` ）： `p2` 以放大后的边界被完整取出，返回的 `chunk` 覆盖其后相邻的 `p3` 。
- 顺序要求：覆写须在 `free` 之后进行；若先改大再 `free` ， `free` 会按篡改后的 `size` 查找 `next_chunk` 并检查，直接失败。
- 覆盖后的写入视图（从取出的 `chunk` 用户区起算）：
	- 偏移 `0xf0` ： `p3` 的 `prev_size` 字段；
	- 偏移 `0xf8` ： `p3` 的 `size` 字段（重叠后的首要改写目标）；
	- 偏移 `0x100` ： `p3` 的用户区（ `p3` 释放后即为 `fd` ）。
- 释放被覆盖 `chunk` 的前置修复： `p3.size` 的 `PREV_INUSE` 位在其前方 `chunk` 释放时已被清除，直接 `free(p3)` 会触发 `consolidate_backward` ，回溯目标（取出的 `chunk` ）不在任何 `bin` 中， `unlink` 检查不通过。需先经取出的 `chunk` 将 `p3.size` 写回 `0x81` ，恢复 `PREV_INUSE` 位，再 `free(p3)` 即可正常进入 `bin` ，其 `fd` 、 `bk` 随即可被随意篡改。
- 版本注意： `>= 2.26` 需处理 `tcache` ；取出环节在较新版本中同样存在 `prev_size` 检查，需按篡改后的 `size` 覆写对应位置。

---

## 三、`overlapping_chunks_2`（改大 · 合并环节）

- 别名：Nonadjacent Free Chunk Consolidation Attack（非相邻空闲 `chunk` 合并攻击，how2heap 注释所引资料的称法）。
- 与上一手法的区别：先改 `size` 再 `free` ，欺骗对象为 `free` 的合并过程，而非取出环节。
- 流程（1000 字节演示，各 `chunk` 为 `0x3f0` 、可用 `0x3e8` ）：
	1. 连续申请五个 `chunk`（ `p1` ~ `p5` ）； `free(p4)` ，使其进入 `unsorted_bin` ；
	2. 溢出将 `p2.size` 覆写为 `0x7e1`（ `0x3e8 + 0x3e8 + 1 + 0x10` ），使 `p2` 的 `next_chunk` 按 `size` 恰好落在 `p4` ；
	3. `free(p2)` ：按 `size` 计算的 `next_chunk` 为 `p4` ，且 `p4` 空闲，触发合并，跨度为 `0x7e0 + 0x3f0 = 0xbd0` ，中间的 `p3`（仍处于分配状态）被并入合并范围；
	4. `malloc(2000)`（ `nb = 0x7e0` ）：从合并块中取出，返回的 `chunk` 覆盖 `p3` 。
- 要点： `free` 仅按 `size` 字段推算 `next_chunk` ，不检查两者之间实际是否存在其他 `chunk` （即别名中 Nonadjacent 的含义）。
- 版本：收录于 how2heap 早期目录（ `2.23` / `2.24` ）。

---

## 四、`poison_null_byte`（改小 · 保护 `prev_size` ）

- 流程（ `b` = `0x210` 、 `c` = `0x110` ，偏移自堆基址起算）：
	1. （ `>= 2.26` ）在 `free(b)` 前，将 `0x310` 处覆写为 `0x200` ，原理见“检查适配”；
	2. `free(b)` ： `b` 进入 `unsorted_bin` ； `c.prev_size` 被写为 `0x210` ， `c.size` 的 `PREV_INUSE` 被清除；
	3. `off_by_null` 将 `b.size` 由 `0x211` 缩小为 `0x200` ；
	4. `malloc(0x100)` ： `b` 从 `unsorted_bin` 取出（取出时的 `unlink` 读取 `0x310` 处的值完成检查），拆出 `b1`（ `0x110` ）与剩余块（ `0xF0` ）； `set_foot` 将 `0x310` 处写为 `0xF0` ；
	5. `malloc(0x80)` ：继续拆出 `b2`（ `0x90` ）与剩余块（ `0x60` ）； `set_foot` 将 `0x310` 处写为 `0x60` ；
	6. `free(b1)` ： `b1` 进入 `unsorted_bin` ，作为后续 `unlink` 的目标；
	7. `free(c)` ： `c.size` 的 `PREV_INUSE` 为 0，按 `prev_size = 0x210` 回溯至 `b1` ； `unlink` 通过后合并，范围为 `0x320`（ `[0x110, 0x430)` ）， `b2` 被覆盖；
	8. `malloc(0x300)` ：整个合并块被取出，覆盖 `b2` 。
- 为什么必须改小：
	- 若不改小，拆分产生的 `set_foot` 落在 `c` 的 `chunk` 头（ `0x320` ），将 `c.prev_size` 覆写为剩余块大小（ `0x70` ），回溯无法跨越 `b2` ；
	- 改小后，所有 `set_foot` 的落点前移至 `0x310` ， `c.prev_size` 保持 `0x210` 不变，回溯可直达 `b` ；
	- 缩小的幅度由低字节决定（ `0x11 → 0x10` 、 `0x21 → 0x20` ），只需保证按 `size` 推算的末尾位置与 `c` 的 `chunk` 头不再重合。
- 检查适配：
	- `>= 2.26` ： `unlink` 新增 `chunksize(P) != prev_size(next_chunk(P))` 检查（commit `17f487b` ）。 `size` 缩小后， `next_chunk(P)` 的位置随 `size` 前移至 `0x310` ，恰好落在 `b` 自己的用户区内（偏移 `0x1f0` ）。因此只需在 `free(b)` 前将该处覆写为 `0x200` ，即可在第一次取出时通过检查。此后 `0x310` 处会被 `set_foot` 反复覆写，但检查已经完成，不再影响。
	- `>= 2.29` ： `consolidate` 前新增 `chunksize(p) != prevsize` 检查（ `corrupted size vs. prev_size while consolidating` ）， `free(c)` 环节被阻断。

---

## 五、公共机制

### `consolidate_backward`（ `free` 时与前一 `chunk` 合并）

1. `c.size` 的 `PREV_INUSE` 为 0 时，读取 `c.prev_size` ；
2. 按 `prev_size` 回溯： `p = c − prev_size` ；
3. （ `>= 2.29` ）检查 `chunksize(p) == prev_size` ；
4. `unlink(p)` ：读取 `p->fd` 、 `p->bk` ；检查 `FD->bk == p && BK->fd == p` ；写回 `FD->bk = BK` 、 `BK->fd = FD` ；
5. 合并结果放入 `unsorted_bin` ；若 `next_chunk` 为 `top` ，则直接并入 `top` 。

整个流程只读取 `c.size` 的最低位、 `c.prev_size` 与 `p` 的 `fd` / `bk` ，不检查 `c` 与 `p` 之间是否存在其他内容——这是跨 `chunk` 合并得以成立的原因。

### `free` 顺序要求

被回溯的目标 `chunk`（如 `poison_null_byte` 中的 `b1` ）必须先 `free` 。 `unlink` 要求目标处于 `bin` 中、 `fd` / `bk` 为合法链表指针；若尚未释放， `fd` / `bk` 的位置为其用户数据，检查不通过，触发 `corrupted double-linked list` 。合并的跨度由 `prev_size` 与 `c.size` 决定，与目标 `chunk` 自身的 `size` 无关。

### 新增检查的读取位置

`glibc 2.26` 新增的 `prev_size` 检查，其读取位置由篡改后的 `size` 计算得出，通常落在可写区域内，因此在 `2.26` ~ `2.28` 上可通过提前覆写满足； `2.29` 的 `consolidating` 检查则直接比对 `prev_size` 与 `p` 的实际 `chunksize` ，阻断了 `poison_null_byte` 的回溯路径。

---

## 六、版本对照

- `2.23` ：三个手法均直接可用； `poison_null_byte` 无需前置覆写；
- `2.26` ~ `2.28` ： `unlink` 新增 `prev_size` 检查， `poison_null_byte` 与 `overlapping_chunks` 需提前覆写对应字段；同时出现 `tcache` ，需填满或绕过；
- `2.29` 起： `consolidating` 检查阻断了 `poison_null_byte` 的 `free(c)` 环节。

---

## 七、利用出口

- 重叠建立后，可篡改相邻 `chunk` 的 `size` 、 `fd` 、 `bk` ，配合 `fast_bin_attack` 、 `unsorted_bin_attack` 等原语实现任意地址写；
- 结合题目自身的读功能，可进一步完成 `libc` 与 `heap` 基址的泄露。

---
## 🔗 关联与参考

- how2heap（[项目链接](https://github.com/shellphish/how2heap)）
- `unlink` 检查来源：commit `17f487b`
- `overlapping_chunks_2` 注释所引 SJTU 资料
