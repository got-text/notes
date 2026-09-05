---
title: Fuzz_1
timestamp: 2026-08-27 23:14:24+08:00
toc: true
tags: [Manual, Fuzz, 代码审计, Vulnerability_Mining]
---
# ***由 CVE-2019-13288 开始的 Fuzz 之旅***

## **关于环境配置**
---
在主要上应分为两部分，即Fuzz的主体 `AFL++` ，与客体即存在漏洞的对象(在此处应为`xpdf`)的配置
### AFL++
此处学习中使用 `docker` 容器环境，如下图所示
![](/notes/pictures/Fuzz_1/Pasted%20image%2020260616102837.webp)
 在此处补充使用的 `docker` 命令
```bash
# ==============================================================
# 关于 docker 容器的创建
# ==============================================================
docker run -it \
  --name AFLpp \  # 为容器指定一个易辨识的名字
  --privileged \  # 给予容器特权模式
  -v /home/pwn/Documents/src:/home/pwn/Documents/src \  # 挂载文件目录
  -w /home/pwn/Documents/src \  # 添加工作目录，启动时自动切换
  aflplusplus/aflplusplus:latest \  # 使用官方最新版的 AFL++ 镜像
  tail -f /dev/null # 锁死后台，确保容器永不退出，可随时唤起
# ==============================================================
# 关于 docker 容器的使用
# ==============================================================
# 1. 如果容器处于停止状态，使用此命令启动并直接进入交互终端
docker start  AFLpp

# 2. 如果容器已经在后台运行，使用此命令开启一个新的 Bash 终端进入
docker exec -it AFLpp /bin/bash

# 3. 停止该容器
docker stop AFLpp
# ==============================================================
# 关于 docker 文件复制
# ==============================================================
# 格式均为：docker cp [源路径] [目标路径]
# 1. 从 宿主机 复制文件/文件夹 到 容器内
docker cp /path/to/local/test.jpg AFLpp:/home/pwn/Documents/src/

# 2. 从 容器内 复制文件/文件夹 到 宿主机

docker cp AFLpp:/home/pwn/Documents/src/out/default/crashes .
# ==============================================================
```
### xpdf
此处为构建的原始版本，为实现 `fuzz` ，需要 `AFL++` 对源码进行特殊处理，完成插桩后重新进行构建，此处将在下文展示
```bash
# ==============================================================
# 下载并构建 xpdf
# ==============================================================
wget https://dl.xpdfreader.com/old/xpdf-3.02.tar.gz
tar -xvzf xpdf-3.02.tar.gz
cd xpdf-3.02
sudo apt update && sudo apt install -y build-essential gcc
./configure --prefix="/home/pwn/Documents/src/fuzzing_xpdf/install/"
make
make install
```
### 源码模式插桩
在 `docker`环境中进行构建，生成具有 `__afl` 符号的二进制文件。与此同时，插入用来记录分支选择的代码，文件大小也就产生膨胀(此处由 `KB`->`MB`)
```bash
# ==============================================================
# 源码模式 构建插桩项目
# ==============================================================
export LLVM_CONFIG="llvm-config-11"
CC=$HOME/AFLplusplus/afl-clang-fast CXX=$HOME/AFLplusplus/afl-clang-fast++ ./configure --prefix="/home/pwn/Documents/src/fuzzing_xpdf/install/"
make
make install
```
![](/notes/pictures/Fuzz_1/Pasted%20image%2020260616113743.webp)

---
## **从运行命令探究Fuzz运行之关键**
`Fuzz` 的本质即不断对程序输入通过变异算法变化的特殊数据，来探索程序所有的分支可能，而找到会产生 `crash` 的部分，以此寻找到程序可能存在的漏洞

---
```bash
afl-fuzz \  # 运行 fuzz 程序
  -i ./pdf_examples/ \   # 输入文件夹
  -o ./out/ \  # 结果输出
  -s 123 \  # 变异种子
  -- ./install/bin/pdftotext @@ /dev/null  # 指定程序运行方式
```
### 寻根溯源，择优而选 -i
通过对种子文件的精简与选择，可以极大的加速 `fuzz` 的测试速度，减少算力的浪费，是高效率 `fuzz` 的基础
#### 一. 结构合法性原则
>其主要目的是跳过程序的浅层拒绝逻辑，使程序直接开始对程序主要逻辑进行 `Fuzz` 一般而言通过两种方式来构造得到对应的种子

##### 1. 寻找
（1）对于开源项目可以直接查看项目用例
（2）对于通用格式（如 `png` 、`pdf` ）可以查看官方的测试文档，或者通过市面上已有的种子库寻找极简种子库
（3）对于少见的特殊格式，则尝试通过 `google` 语法尝试搜索暴露的合法私有文件
##### 2. 构造
（1）对文本、字符串、结构化数据可尝试手写，手写时应做到尽量精简，只保留最基础的内容。（例：对于 `XML` ，手写的种子只包含最基础的闭合标签）

#### 二. 精简至上原则
>为提高 `Fuzz` 的速度，应保证种子文件尽可能精简，减少无效数据，提高测试速度

##### 1. 单文件体积精简
（1）对于找到的较大的合理的文件，应尝试去除各类复杂的数据，在保证程序能正常读取的情况下，尽量精简
（2）通过 `afl-tmin` 在不影响搜索路径的情况下，减少种子文件字节数，降低其体积大小 （以下为afl-tmin的命令案例）
`afl-tmin -i ./seed1.pdf -o ./seed1_min.pdf -- ./pdftotext @@ /dev/null`
##### 2. 多文件数量精简
（1）通过 `afl-cmin` 去除所有路径完全相同的原始种子，减少种子数量，但保留抵达特殊路径的种子（以下为 `afl-cmin` 的命令案例）
`afl-cmin -i ./raw_seeds/ -o ./clean_seeds/ -- ./pdftotext @@ /dev/null`
#### 三. 功能单一性原则
>尽量保证种子文件的子结构不同，保证程序在分发器中即进入不同的分支
>在工程实现上应当遵循[模块隔离 单点爆破]的原则，构造不同功能的最简种子文件。

（1）看该文件格式的官方规范，独立章节介绍或用不同的标识符区分数据块视为不同功能
（2）对测试程序进行逆向分析，通过分析分发器部分，不同分支即视为不同功能
（3）如有源码，则可通过源码的类文件分类进行判断

- 种子 1：仅包含极简文本 （专攻文本解析、词法分析与缓冲区逻辑）
- 种子 2：仅包含 1x1 像素的嵌入式图片 （专攻图片解码引擎）
- 种子 3：仅包含长达 50 层的空对象嵌套（专攻解析器的递归层级溢出防御）
- 种子 4：仅包含一个空的加密证书表单（专攻安全验证模块）
#### 四、路径最大化原则
>用最具代表性的初始样本集，保证探索目标程序尽可能多的底层控制流分支

##### 1. 多文件路径覆盖（异质互补）
 在构建种子库时，应确保每一个加入的种子，能让程序走向完全不同的代码深处。
 收集不同版本标准不同工具生成的极简文件
##### 2. 工具链辅助判定
 依赖插桩反馈进行盲区测绘
 `afl-showmap -m none -o ./seed1.map -- ./pdftotext ./seed1.pdf /dev/null`
 通过对比不同种子的 .map 文件得到能抵达不同路径的种子文件
 
---
### 按图索骥 循迹追凶 -s
##### 1. 终极复现
通过显式指定随机数，可以进行一次确定的 `fuzz` 过程，通过再次指定相同的种子，可以对进行的测试进行一次重放
##### 2. 集团作战 多线并行
在多核服务器上开启多进程并行 `Fuzzing` 则需指定不同种子，以免造成算力的浪费
```bash
afl-fuzz -i ./pdf_in -o ./pdf_out -M fuzzer_core1 -s 1111 -- ./pdftotext @@ /dev/null &

afl-fuzz -i ./pdf_in -o ./pdf_out -S fuzzer_core2 -s 2222 -- ./pdftotext @@ /dev/null &

afl-fuzz -i ./pdf_in -o ./pdf_out -S fuzzer_core3 -s 3333 -- ./pdftotext @@ /dev/null &
```
---
### 巧借跳板 暗渡陈仓 --
`-- ./install/bin/pdftotext @@ /dev/null`
- `@@`
	此处为所测试程序的真正执行区域，此处 `@@` 会被视为占位符，在真正执行的时候会被替换为对应的种子文件路径，作为程序的输入
- `/dev/null`
	`/dev/null` 则为程序输出的重定向，直接将输出抛弃可以减少算力消耗

随之 `fuzz` 就真正运行起来了，以下是程序运行的截图
![](/notes/pictures/Fuzz_1/Pasted%20image%2020260618024613.webp)
应关心以下部分
#### 1. `item geometry` - `stability`（路径稳定性）
应保证路径稳定性数值处于 95% - 100% 之间，即路径差异始终处于较小的状态。一旦稳定性低于 90%，则应检查程序中所可能存在的 ***随机数、时间戳、多线程竞争或未初始化的内存*** 而后排查并锁死程序的随机源。
#### 2. `overall results` - `saved crashes`（独特性崩溃数）
即最终测试所得到的导致程序崩溃的种子数量，应注意此处为去重后的数量，一旦产生崩溃，就获得了通往漏洞的钥匙
#### 3. `stage progress` - `exec speed`（算力吞吐率）
模糊测试本质是“用算力换漏洞”的概率游戏，因此应保证算力吞吐率保持在一个尽量高的值。源码模式应保持在 `> 500/sec`,  `100/sec` 视为红线。 `QEMU` 模式应 `> 100/sec`，  `50/sec` 视为红线

---
### 剥瓤去核 由此可得 -o

![](/notes/pictures/Fuzz_1/Pasted%20image%2020260617211359.webp)
接下来需要进行的就是通过 `GDB` 进行调试，以查看程序的调用栈，并尝试对漏洞进行分析
在 `crashes` 目录下执行以下命令
```bash
gdb --args ../../../install/bin/pdftotext ./id:000000,sig:11,src:000784,time:291688,execs:223629,op:havoc,rep:4 /dev/null
```
然后完成相对应的漏洞报告<a href="/notes/note/zh-cn/二进制漏洞分析模板">二进制漏洞分析模板</a>

#### 先知其然（最开始的信息搜集）
##### 1. 漏洞信息 
###### (1)漏洞简述
>漏洞名称 （中文）
>漏洞编号（cve编号）
>漏洞类型：（整数溢出、UAF、设计缺陷等）
>漏洞影响：（远程代码执行、信息泄露等）
>CVSS评分：（以CVSS 3.0为准（一般分数较高），或者2者都备注）
>利用难度：Medium
>基础权限：不需要（是否需要普通用户权限）

对于此部分来说可通过相应网站查询
[CNVD: 国家信息安全漏洞共享平台](https://www.cnvd.org.cn/)
[NVD: National Vulnerability Database](https://nvd.nist.gov/)
[CVE: Common Vulnerabilities and Exposures](https://www.cve.org/)
##### 2. 组件概述
如果是操作系统组件，简单介绍组件的大概情况：是什么，用处，用在什么地方，使用范围等。
##### 3. 漏洞利用
简述漏洞利用过程和成功利用的效果，精简凝练。
>通过xxxx的操作(通道)，触发了什么错误，达成了什么效果
##### 4. 漏洞影响
漏洞影响的详细软件或操作系统版本。
##### 5. 解决方案
官方的安全更新方案，给出链接。

#### 而后知其所以然（漏洞复现）
##### 1. 靶机环境搭建
###### (1)系统及其版本
例： `Ubuntu 24.04 LTS` 
###### (2)程序及其版本
例： `Xpdf v3.02`
##### 2. 分析环境搭建
###### (1)Fuzzing引擎及其版本
例：`afl-fuzz++5.01a`
###### (2)调试工具
例：`GDB` (如有增强插件也需注明) 、 ldd
###### (3)静态分析工具
例：`IDA Pro` 、`Ghidra
##### 3. 复现过程
###### (1)获取源码或漏洞程序本体
开源项目：可直接前往对应的项目地址进行下载构建
```bash
# 1. 下载特定的有漏洞源码包
wget https://dl.xpdfreader.com/old/xpdf-3.02.tar.gz
tar -xvzf xpdf-3.02.tar.gz
# 2。安装构建环境，并构建程序
cd xpdf-3.02
sudo apt update && sudo apt install -y build-essential gcc
./configure --prefix="$HOME/fuzzing_xpdf/install/"
make
make install
```
###### (2)PoC (漏洞样本获取)
即通过 `Fuzz` 所获得或者如何进行编写，如果是已知漏洞则可直接下载漏洞 `PoC`
###### (3)运行程序 崩溃确认
```bash
# 运行以下命令，确认程序确实产生崩溃
/home/pwn/Documents/src/fuzzing_xpdf/install/bin/pdftotext \
  /home/pwn/Documents/src/fuzzing_xpdf/out/default/crashes/id:000000... /dev/null
```
![](/notes/pictures/Fuzz_1/Pasted%20image%2020260619101328.webp)

#### 格其物（漏洞分析）
##### 1. 漏洞基本信息
###### (1)漏洞文件
>对于源码模式插桩应该写明漏洞源码文件，如为 `QEMU` 模式则应写明其程序名(链接库名、内核模块名)

例：`xpdf/XRef.cc`
###### (2)漏洞函数
>应当写明的应该是崩溃的入口点，补丁修复位置，或者说逻辑失控点(注：调用栈为自下而上)

那么在此处来说漏洞函数应该为`Parser::makeStream`
例：`xpdf-3.02/xpdf/Parser.cc` 中的 `Parser::makeStream`
![](/notes/pictures/Fuzz_1/Pasted%20image%2020260619111317.webp)

###### (3)漏洞对象
>代码层次崩溃对象和数据层面对应的造成崩溃的数据

例：`xpdf` 中的 `Parser` 模块，具体指向 `PDF` 规范中的 `Stream` 字典对象
##### 2. 背景知识
>在此处应为pdf文件结构
```pdf
%PDF-1.1
% ▲======= 1. 文件头 (Header) =======▲
% 作用：声明当前文件遵循 PDF 1.1 规范。解析器读取第一行来决定采用何种版本的标准进行解码。
% =============================================================
% ▲======= 2. 文件体 (Body: 逻辑对象树区域) =======▲
% =============================================================
1 0 obj
% 定义 1号间接对象（Generation号为0）。
<< 
  /Type /Catalog         % 声明该对象的类型为“目录(Catalog)”，即整个 PDF 逻辑树的根节点(Root)。
  /Pages 2 0 R           % 关键逻辑指针：指明管理页面树的大管家是「2号间接对象」。
>>
endobj
% 1号对象闭合。

2 0 obj
% 定义 2号间接对象（页面大管家）。
<< 
  /Type /Pages           % 声明类型为“页面树(Pages)”，负责统筹、管理、索引物理页面。
  /Count 1               % 告知解析器：当前 PDF 文件总共只有 1 个有效页面。
  /Kids [ 3 0 R ]        % 关键逻辑数组：具体的页面对象按照顺序排列，这里指向「3号间接对象」。
>>
endobj
% 2号对象闭合。

3 0 obj
% 定义 3号间接对象（具体的单张画布/页面）。
<< 
  /Type /Page            % 声明类型为“单页(Page)”。
  /Parent 2 0 R          % 双向链表指针：指明自己的上级父节点是 2号对象。
  /MediaBox [ 0 0 300 144 ] % 物理视口剪裁：定义画布的分辨率/尺寸（左下角x, 左下角y, 右上角x, 右上角y）。
  /Contents 4 0 R        % 关键逻辑指针：指明本页面的具体画面内容、文字流存储在「4号间接对象」中。
  /Resources << >>       % 资源字典：用于存放本页内嵌的字体、图片等资源名称，此处为空。
>>
endobj
% 3号对象闭合。

4 0 obj
% 定义 4号间接对象（内容流，本次漏洞涉案的核心数据类型）。
<< 
  /Length 55             % 静态标量长度：显式告知解析器，下面的 stream 裸数据严格占据 55 个字节。
                         % 【安全延伸】：若此处被黑客篡改写为间接引用（如 5 0 R），则会诱发 XRef::fetch。
>>
stream
BT                      % Text Begin：文本对象开始标记
/Helvetica 18 Tf        % Text Font：设置字体为 Helvetica，字号为 18 磅
20 50 Td                % Text Position：设置文本绝对坐标偏移量（x=20, y=50）
(Hello, world! I Love CTF.) Tj % Text String：在屏幕上渲染并打印括号内的字符串
ET                      % Text End：文本对象结束标记
endstream
% 数据流结束标签。
endobj
% 4号对象闭合。
% =============================================================
% ▲======= 3. 交叉引用表 (XRef Table: 物理寻址索引) =======▲
% =============================================================
xref
% 关键字宣告：物理交叉引用表开始。
0 5
% 声明本段索引的规则：从 0 号对象开始，连续记录 5 个对象的物理偏移量（包含隐含的0号空对象）。
0000000000 65535 f 
% 0号对象固定保留槽：偏移量为0，生成号为65535，状态为 'f' (free，空闲/链表头)。
0000000018 00000 n 
% 1号对象索引：位于文件绝对第 18 字节处，生成号0，状态 'n' (in-use，正在使用)。
0000000069 00000 n 
% 2号对象索引：位于文件绝对第 69 字节处，生成号0，状态 'n'。
0000000127 00000 n 
% 3号对象索引：位于文件绝对第 127 字节处，生成号0，状态 'n'。
0000000241 00000 n 
% 4号对象索引：位于文件绝对第 241 字节处，生成号0，状态 'n'。
% =============================================================
% ▲======= 4. 文件尾 (Trailer: 解析器的第一落脚点) =======▲
% =============================================================
trailer
% 关键字宣告：文件尾字典开始。
<< 
  /Size 5                % 声明交叉引用表中的总条目数为 5 条。
  /Root 1 0 R            % 逻辑起点：指定整个 PDF 对象的“根(Root)”从「1号间接对象」开始。
>>
startxref
348
% 物理起点：告知解析器，从文件首字节数起，第 348 个字节正是 `xref` 关键字的物理起始位置。
%%EOF
% 文件结束标记（End of File）。
```

#### 致其知（详细分析）

- 对于代码审计来说，应当关注以下的两点
1. 数据流流向
	数据流是漏洞利用的着手点，同时也是利用者的手段，通过传递恶意数据，数据经过程序的传递与处理之后，最终达到漏洞点，并在最终出发漏洞，因此通过跟踪数据流，我们即可找到程序中的漏洞点，并且想到对应的修补方案
2. 控制流流向
	控制流则是漏洞分析的脉络，甚至是利用者的最终目的，能够通过此漏洞达到 ACE (任意代码执行)， 是利用者利用漏洞的终点，也就是实现改变控制流流向
- 

##### 1. 管中窥豹 探其虚实 (基础分析)
>在进行漏洞分析的时候首先应做到的就是寻找到对应的漏洞函数，那么在这一步，通过gdb进行栈回溯是很好的方法，示例如下
```bash
gdb --args ../../../install/bin/pdftotext ./id:000000,sig:11,src:000784,time:291688,execs:223629,op:havoc,rep:4 /dev/null
```
```text
(gdb) r
# run
(gdb) bt 
# backtrace  # bt 20 ——展示程序最后调用栈 bt 20 ——展示程序最初调用栈
	
```
![](/notes/pictures/Fuzz_1/Pasted%20image%2020260619141936.webp)
###### 1. 因循守职 顺理成章 （源码模式）
>对于源码模式来说，通过栈回溯可以很轻易的找到程序运行过程之中的函数，而后即可前往源文件进行对照与静态分析（应注意XXX::YYY中，XXX为类名，在源码中找到同名文件即可，YYY为方法名，进入文件后进行搜索迅速定位）

###### 2. 循序渐进 功不唐捐 （ `QEMU` 模式）
>对于 `QEMU` 模式来说，由于缺乏源文件，导致进行栈回溯时缺少方法名，就只能通过地址来寻找到对应的程序代码
>`相对偏移（RVA） = GDB 代码地址 - 模块加载基地址（ImageBase） `
>通过这样的方式获得RVA后，即可使用静态工具，跳转到对应地址，进行静态分析

##### 2. 静水流深 抽丝剥茧 影随形动 步步为营 (动静态代码分析)
在其中，最应该关注以下几个关键
- 控制流分支条件
- 数据流类型与边界变换
- 隐式调用的隐藏逻辑
>在静态代码审计进行漏洞分析的时候，应当是基于最开始的基础分析来进行的，也就是以在上文中找到的漏洞点为锚点，以交叉引用作为轴线，然后按顺序，逐节分析，得到结论

###### 1. 逆向回溯函数调用链
>在宏观层面上，漏洞根因溯源遵循着由结果反推原因的逆向方向；但在微观层面上，对物理程序栈的解构则必须契合 CPU 真实的正向执行轨迹
![](/notes/pictures/Fuzz_1/Pasted%20image%2020260620014158.webp)

已知程序崩溃在 `Parser::getObj` 那么相对应的就去查询最底层的函数调用栈，然后依次查看函数调用，在此处可以回溯至 `XRef::fetch`
- <a href="/notes/note/zh-cn/fuzz_1#xreffetch">Fuzz_1#XRef fetch</a>
```cpp
//=============================================================
						// XRef::fetch - 46
//=============================================================
 parser->getObj(obj, encrypted ? fileKey : (Guchar *)NULL,
                   encAlgorithm, keyLength, num, gen);
```
向上回溯到可以回溯到 `Object::dictLookup` 内联函数
- <a href="/notes/note/zh-cn/fuzz_1#objectdictlookup">Fuzz_1#Object dictLookup</a>
```cpp
inline Object *Object::dictLookup(char *key, Object *obj)
  { return dict->lookup(key, obj); }
```
对应的 `lookup` 函数
<a href="/notes/note/zh-cn/fuzz_1#objectlookup">Fuzz_1#Object Lookup</a>
```cpp
// =============================================================
Object *Dict::lookup(char *key, Object *obj) {
  DictEntry *e;

  return (e = find(key)) ? e->val.fetch(xref, obj) : obj->initNull();
}
```
继续向上追溯至 `Parser::makeStream
- <a href="/notes/note/zh-cn/fuzz_1#parsermakestream">Fuzz_1#Parser makeStream</a>`
```cpp
  //============================================================
					  // Parser::makeStream - 15
  //============================================================
  // get length
  dict->dictLookup("Length", &obj);
  if (obj.isInt()) {
    length = (Guint)obj.getInt();
    obj.free();
  } else {
    error(getPos(), "Bad 'Length' attribute in stream");
    obj.free();
    return NULL;
  }
```
最后重新回到 `Parser getObj`
- <a href="/notes/note/zh-cn/fuzz_1#parsergetobj">Fuzz_1#Parser getObj</a>
```cpp
//============================================================
					// Parser::getObj - 66
//============================================================
    if (allowStreams && buf2.isCmd("stream"))
    {
      if ((str = makeStream(obj, fileKey, encAlgorithm, keyLength,
                            objNum, objGen)))
      {
        obj->initStream(str);
      }
      else
      {
        obj->free();
        obj->initError();
      }
    }
```
###### 2. 补丁 `DIFF` 防御分析
>通过 查看 `DIFF` 文件，对补丁前后进行比较，那么就可以相对应的了解到防守方案。对于源码模式来说可以直接比较源码，产生结果，而对于 `QEMU` 模式来说，则需要对二进制文件进行比较，使用 `IDA Pro` 插件 `bin diff` 查看异同

`DIFF` 文件一般而言可以有以下几种方式：
-  通过官方漏洞库查看对应区域，获得补丁链接进行下载
-  如果无法通过第一个方法直接获得补丁，可以下载高版本源码或程序，进行手动 `diff`
	`diff -u xpdf-3.02/xpdf/Parser.cc xpdf-4.04/xpdf/Parser.cc > patch.diff`

在此案例中，经过对 `DIFF` 文件的代码审计，我们可以看到，官方在函数中添加了一个叫做 `recursion` 的整型变量，对递归层数进行记录，一旦超过限制，则退出，以此解决了无限递归问题
- <a href="/notes/note/zh-cn/fuzz_1#parsergetobj_404_302_diff">Fuzz_1#Parser getObj_4.04_3.02_diff</a>
```diff
//============================================================
			// Parser::getObj_4.04_3.02_diff - 27
//============================================================
-Object *Parser::getObj(Object *obj, Guchar *fileKey,
+Object *Parser::getObj(Object *obj, GBool simpleOnly,
+		       Guchar *fileKey,
 		       CryptAlgorithm encAlgorithm, int keyLength,
-		       int objNum, int objGen) {
+		       int objNum, int objGen, int recursion) {
//============================================================
			// Parser::getObj_4.04_3.02_diff - 55
//============================================================
   // dictionary or stream
-  } else if (buf1.isCmd("<<")) {
+  } else if (!simpleOnly && recursion < recursionLimit && buf1.isCmd("<<")) {

-	error(getPos(), "Dictionary key must be a name object");
+	error(errSyntaxError, getPos(),
+	      "Dictionary key must be a name object");

-	obj->dictAdd(key, getObj(&obj2, fileKey, encAlgorithm, keyLength,
-				 objNum, objGen));
+	obj->dictAdd(key, getObj(&obj2, gFalse,
+				 fileKey, encAlgorithm, keyLength,
+				 objNum, objGen, recursion + 1));

-      error(getPos(), "End of file inside dictionary");
+      error(errSyntaxError, getPos(), "End of file inside dictionary");

     if (allowStreams && buf2.isCmd("stream")) {
       if ((str = makeStream(obj, fileKey, encAlgorithm, keyLength,
-			    objNum, objGen))) {
+			    objNum, objGen, recursion + 1))) {

```

###### 3.  漏洞函数分析
>对特定函数进行分析，需要说明函数功能，还原程序逻辑，解析漏洞产生的原因，明确漏洞触发的条件，跟踪恶意数据如何产生影响，并进行整理
-  `Parser::getObj`
	文件解析器部分，`getObj` 用来获取对象信息，并尝试进行解析的分发
-  `XRef::fetch`
	外部参照部分，`fetch` 用来获取简单的对对象信息，并创建一个新的文件解析器对象
- `Parser::makeStream`
	文件解析器部分，`makeStream` 用来对流数据进行处理

- `PDF` 文件内容
![](/notes/pictures/Fuzz_1/Pasted%20image%2020260620151938.webp)
那么当此 `pdf` 文件被加载进程序后，在初始阶段会产生以下调用尝试解析文件。通过分析，可以看到，在 解析 `2 0 obj` 时会对 `Kids` 数组进行解析
![](/notes/pictures/Fuzz_1/Pasted%20image%2020260620153709.webp)
由于`Kids` 数组未闭合导致直至文件末尾均被认为是数组中的内部成员，而后不断向后尝试解析内部对象并添加，因此调用 `Parser::getObj`
```cpp
  // array
  if (buf1.isCmd("["))
  {
    shift();
    obj->initArray(xref);
    while (!buf1.isCmd("]") && !buf1.isEOF())
      obj->arrayAdd(getObj(&obj2, fileKey, encAlgorithm, keyLength,
                           objNum, objGen));
```
对于这样的一次循环来说，会产生三个 `Parser::getObj`， 分别对 `2 0 obj Kids` 数组，`3 0 obj Resources` 资源字典， 与最后的破损流对象 `5 0 obj` 进行解析,产生如下调用
![](/notes/pictures/Fuzz_1/Pasted%20image%2020260620160606.webp)
其中，在`5 0 obj` 由于存在 `/Length 2 0 R` 即对 `2 0 obj` 的间接引用，使得程序不得不跳出现在执行流，创建一个新的解析器， 重复此流程，并最终导致无限递归，并最终引发程序的崩溃

####  欲烧赤壁 需借东风 （利用条件）
- 要成功引爆该漏洞，目标系统或受害者环境必须满足以下条件：
	- **场景/服务**：
		目标系统后台采用了未打补丁的 `xpdf`（或使用相同底层 `Parser`/`XRef` 逻辑的开源解析组件），用于自动处理、预览或提取用户上传的 PDF 文件
	- **配置条件**：
		解析器未对进程的系统栈大小（`ulimit -s`）做过激进的物理缩减或动态防护
	- **触发操作**：
		攻击者无需进行复杂的交互，仅需将精心构造的恶意 PDF 字节流上传或提交至目标系统
	- 
- 
#### 亡羊补牢 未为晚也 （补救措施）
详情见以下部分
- <a href="/notes/note/zh-cn/fuzz_1#2补丁diff防御分析">Fuzz_1#2. 补丁 `DIFF` 防御分析</a>


## **硝烟散尽 乾坤落定** -  ***FIN***
这篇文章确实是花了非常多的时间，作为 `Fuzz` 开始的第一部分，后面确实还有很远的路，但是毫无疑问的是，这会是所迈出的坚实的一步
- 此处应有音乐
[The Phoenix](https://www.bilibili.com/video/BV1iA4m157rr/?spm_id_from=333.337.search-card.all.click&vd_source=2cd1d0a702ddbe4a54565570a658ec65)

---
---

## **关键函数代码块**
### Parser::makeStream
```cpp
// =============================================================
Stream *Parser::makeStream(Object *dict, Guchar *fileKey,
			   CryptAlgorithm encAlgorithm, int keyLength,
			   int objNum, int objGen) {
  Object obj;
  BaseStream *baseStr;
  Stream *str;
  Guint pos, endPos, length;

  // get stream start position
  lexer->skipToNextLine();
  pos = lexer->getPos();

  // get length
  dict->dictLookup("Length", &obj);
  if (obj.isInt()) {
    length = (Guint)obj.getInt();
    obj.free();
  } else {
    error(getPos(), "Bad 'Length' attribute in stream");
    obj.free();
    return NULL;
  }

  // check for length in damaged file
  if (xref && xref->getStreamEnd(pos, &endPos)) {
    length = endPos - pos;
  }

  // in badly damaged PDF files, we can run off the end of the input
  // stream immediately after the "stream" token
  if (!lexer->getStream()) {
    return NULL;
  }
  baseStr = lexer->getStream()->getBaseStream();

  // skip over stream data
  lexer->setPos(pos + length);

  // refill token buffers and check for 'endstream'
  shift();  // kill '>>'
  shift();  // kill 'stream'
  if (buf1.isCmd("endstream")) {
    shift();
  } else {
    error(getPos(), "Missing 'endstream'");
    // kludge for broken PDF files: just add 5k to the length, and
    // hope its enough
    length += 5000;
  }

  // make base stream
  str = baseStr->makeSubStream(pos, gTrue, length, dict);

  // handle decryption
  if (fileKey) {
    str = new DecryptStream(str, fileKey, encAlgorithm, keyLength,
			    objNum, objGen);
  }

  // get filters
  str = str->addFilters(dict);

  return str;
}
// =============================================================
```
### XRef::fetch
```cpp
// =============================================================
Object *XRef::fetch(int num, int gen, Object *obj) {
  XRefEntry *e;
  Parser *parser;
  Object obj1, obj2, obj3;

  // 检查是否存在恶意的/伪造的引用 - 这在损坏的 PDF 文件中很常见
  if (num < 0 || num >= size) {
    goto err;
  }

  e = &entries[num];
  switch (e->type) {

  // 场景一：处理未压缩的交叉引用项
  case xrefEntryUncompressed:
    if (e->gen != gen) {
      goto err;
    }
    obj1.initNull();
    
    // 初始化词法分析器(Lexer)与解析器(Parser)，定位到对象在文件中的偏移量(offset)
    parser = new Parser(this,
               new Lexer(this,
                 str->makeSubStream(start + e->offset, gFalse, 0, &obj1)),
               gTrue);
               
    // 连续解析前三个元素，期望匹配标准格式如: "4 0 obj"
    parser->getObj(&obj1);
    parser->getObj(&obj2);
    parser->getObj(&obj3);
    
    // 严格校验对象头合法性：前两个必须是整数，第三个必须是命令 "obj"
    if (!obj1.isInt() || obj1.getInt() != num ||
        !obj2.isInt() || obj2.getInt() != gen ||
        !obj3.isCmd("obj")) {
      obj1.free();
      obj2.free();
      obj3.free();
      delete parser;
      goto err;
    }
    
    // 【致命核心】调用 getObj 解析真正的对象内容。
    // 如果该对象是 Dictionary 且内部包含循环解引用，将通过层层调用链再次触发 XRef::fetch，导致互递归爆栈。
    parser->getObj(obj, encrypted ? fileKey : (Guchar *)NULL,
                   encAlgorithm, keyLength, num, gen);
                   
    // 清理现场，释放内存
    obj1.free();
    obj2.free();
    obj3.free();
    delete parser;
    break;

  // 场景二：处理压缩的对象流(Object Stream)
  case xrefEntryCompressed:
    if (gen != 0) {
      goto err;
    }
    if (!objStr || objStr->getObjStrNum() != (int)e->offset) {
      if (objStr) {
        delete objStr;
      }
      objStr = new ObjectStream(this, e->offset);
    }
    objStr->getObject(e->gen, num, obj);
    break;

  default:
    goto err;
  }

  return obj;

// 错误处理分支
err:
  return obj->initNull();
}
// =============================================================
```
### Parser::getObj
```cpp
// =============================================================
Object *Parser::getObj(Object *obj, Guchar *fileKey,
                       CryptAlgorithm encAlgorithm, int keyLength,
                       int objNum, int objGen)
{
  char *key;
  Stream *str;
  Object obj2;
  int num;
  DecryptStream *decrypt;
  GString *s, *s2;
  int c;

  // refill buffer after inline image data
  if (inlineImg == 2)
  {
    buf1.free();
    buf2.free();
    lexer->getObj(&buf1);
    lexer->getObj(&buf2);
    inlineImg = 0;
  }

  // array
  if (buf1.isCmd("["))
  {
    shift();
    obj->initArray(xref);
    while (!buf1.isCmd("]") && !buf1.isEOF())
      obj->arrayAdd(getObj(&obj2, fileKey, encAlgorithm, keyLength,
                           objNum, objGen));
    if (buf1.isEOF())
      error(getPos(), "End of file inside array");
    shift();

    // dictionary or stream
  }
  else if (buf1.isCmd("<<"))
  {
    shift();
    obj->initDict(xref);
    while (!buf1.isCmd(">>") && !buf1.isEOF())
    {
      if (!buf1.isName())
      {
        error(getPos(), "Dictionary key must be a name object");
        shift();
      }
      else
      {
        key = copyString(buf1.getName());
        shift();
        if (buf1.isEOF() || buf1.isError())
        {
          gfree(key);
          break;
        }
        obj->dictAdd(key, getObj(&obj2, fileKey, encAlgorithm, keyLength,
                                 objNum, objGen));
      }
    }
    if (buf1.isEOF())
      error(getPos(), "End of file inside dictionary");
    // stream objects are not allowed inside content streams or
    // object streams
    if (allowStreams && buf2.isCmd("stream"))
    {
      if ((str = makeStream(obj, fileKey, encAlgorithm, keyLength,
                            objNum, objGen)))
      {
        obj->initStream(str);
      }
      else
      {
        obj->free();
        obj->initError();
      }
    }
    else
    {
      shift();
    }

    // indirect reference or integer
  }
  else if (buf1.isInt())
  {
    num = buf1.getInt();
    shift();
    if (buf1.isInt() && buf2.isCmd("R"))
    {
      obj->initRef(num, buf1.getInt());
      shift();
      shift();
    }
    else
    {
      obj->initInt(num);
    }

    // string
  }
  else if (buf1.isString() && fileKey)
  {
    s = buf1.getString();
    s2 = new GString();
    obj2.initNull();
    decrypt = new DecryptStream(new MemStream(s->getCString(), 0,
                                              s->getLength(), &obj2),
                                fileKey, encAlgorithm, keyLength,
                                objNum, objGen);
    decrypt->reset();
    while ((c = decrypt->getChar()) != EOF)
    {
      s2->append((char)c);
    }
    delete decrypt;
    obj->initString(s2);
    shift();

    // simple object
  }
  else
  {
    buf1.copy(obj);
    shift();
  }

  return obj;
}
// =============================================================
```
### Object::dictLookup
```cpp
// =============================================================
#include "Dict.h"

inline Object *Object::dictLookup(char *key, Object *obj)
  { return dict->lookup(key, obj); }
// =============================================================
```
### Object::Lookup
```cpp
Object *Dict::lookup(char *key, Object *obj) {
  DictEntry *e;

  return (e = find(key)) ? e->val.fetch(xref, obj) : obj->initNull();
}
```
### Parser::getObj_4.04_3.02_diff
```diff
--- xpdf-3.02/xpdf/Parser.cc	2007-02-28 06:05:52.000000000 +0800
+++ xpdf-4.04/xpdf/Parser.cc	2022-04-19 05:11:23.000000000 +0800
@@ -13,6 +13,8 @@
 #endif
 
 #include <stddef.h>
+#include <string.h>
+#include "gmempp.h"
 #include "Object.h"
 #include "Array.h"
 #include "Dict.h"
@@ -21,6 +23,10 @@
 #include "XRef.h"
 #include "Error.h"
 
+// Max number of nested objects.  This is used to catch infinite loops
+// in the object structure.
+#define recursionLimit 500
+
 Parser::Parser(XRef *xrefA, Lexer *lexerA, GBool allowStreamsA) {
   xref = xrefA;
   lexer = lexerA;
@@ -36,9 +42,10 @@
   delete lexer;
 }
 
-Object *Parser::getObj(Object *obj, Guchar *fileKey,
+Object *Parser::getObj(Object *obj, GBool simpleOnly,
+		       Guchar *fileKey,
 		       CryptAlgorithm encAlgorithm, int keyLength,
-		       int objNum, int objGen) {
+		       int objNum, int objGen, int recursion) {
   char *key;
   Stream *str;
   Object obj2;
@@ -57,23 +64,24 @@
   }
 
   // array
-  if (buf1.isCmd("[")) {
+  if (!simpleOnly && recursion < recursionLimit && buf1.isCmd("[")) {
     shift();
     obj->initArray(xref);
     while (!buf1.isCmd("]") && !buf1.isEOF())
-      obj->arrayAdd(getObj(&obj2, fileKey, encAlgorithm, keyLength,
-			   objNum, objGen));
+      obj->arrayAdd(getObj(&obj2, gFalse, fileKey, encAlgorithm, keyLength,
+			   objNum, objGen, recursion + 1));
     if (buf1.isEOF())
-      error(getPos(), "End of file inside array");
+      error(errSyntaxError, getPos(), "End of file inside array");
     shift();
 
   // dictionary or stream
-  } else if (buf1.isCmd("<<")) {
+  } else if (!simpleOnly && recursion < recursionLimit && buf1.isCmd("<<")) {
     shift();
     obj->initDict(xref);
     while (!buf1.isCmd(">>") && !buf1.isEOF()) {
       if (!buf1.isName()) {
-	error(getPos(), "Dictionary key must be a name object");
+	error(errSyntaxError, getPos(),
+	      "Dictionary key must be a name object");
 	shift();
       } else {
 	key = copyString(buf1.getName());
@@ -82,17 +90,18 @@
 	  gfree(key);
 	  break;
 	}
-	obj->dictAdd(key, getObj(&obj2, fileKey, encAlgorithm, keyLength,
-				 objNum, objGen));
+	obj->dictAdd(key, getObj(&obj2, gFalse,
+				 fileKey, encAlgorithm, keyLength,
+				 objNum, objGen, recursion + 1));
       }
     }
     if (buf1.isEOF())
-      error(getPos(), "End of file inside dictionary");
+      error(errSyntaxError, getPos(), "End of file inside dictionary");
     // stream objects are not allowed inside content streams or
     // object streams
     if (allowStreams && buf2.isCmd("stream")) {
       if ((str = makeStream(obj, fileKey, encAlgorithm, keyLength,
-			    objNum, objGen))) {
+			    objNum, objGen, recursion + 1))) {
 	obj->initStream(str);
       } else {
 	obj->free();
@@ -142,30 +151,36 @@
 
 Stream *Parser::makeStream(Object *dict, Guchar *fileKey,
 			   CryptAlgorithm encAlgorithm, int keyLength,
-			   int objNum, int objGen) {
-  Object obj;
-  BaseStream *baseStr;
-  Stream *str;
-  Guint pos, endPos, length;
-
+			   int objNum, int objGen, int recursion) {
   // get stream start position
   lexer->skipToNextLine();
-  pos = lexer->getPos();
-
-  // get length
-  dict->dictLookup("Length", &obj);
-  if (obj.isInt()) {
-    length = (Guint)obj.getInt();
-    obj.free();
-  } else {
-    error(getPos(), "Bad 'Length' attribute in stream");
-    obj.free();
+  Stream *curStr = lexer->getStream();
+  if (!curStr) {
     return NULL;
   }
+  GFileOffset pos = curStr->getPos();
+
+  GBool haveLength = gFalse;
+  GFileOffset length = 0;
+  GFileOffset endPos;
 
   // check for length in damaged file
   if (xref && xref->getStreamEnd(pos, &endPos)) {
     length = endPos - pos;
+    haveLength = gTrue;
+
+  // get length from the stream object
+  } else {
+    Object obj;
+    dict->dictLookup("Length", &obj, recursion);
+    if (obj.isInt()) {
+      length = (GFileOffset)(Guint)obj.getInt();
+      haveLength = gTrue;
+    } else {
+      error(errSyntaxError, getPos(),
+	    "Missing or invalid 'Length' attribute in stream");
+    }
+    obj.free();
   }
 
   // in badly damaged PDF files, we can run off the end of the input
@@ -173,34 +188,108 @@
   if (!lexer->getStream()) {
     return NULL;
   }
-  baseStr = lexer->getStream()->getBaseStream();
 
-  // skip over stream data
-  lexer->setPos(pos + length);
+  // copy the base stream (Lexer will free stream objects when it gets
+  // to end of stream -- which can happen in the shift() calls below)
+  BaseStream *baseStr =
+      (BaseStream *)lexer->getStream()->getBaseStream()->copy();
+
+  // 'Length' attribute is missing -- search for 'endstream'
+  if (!haveLength) {
+    GBool foundEndstream = gFalse;
+    char endstreamBuf[8];
+    if ((curStr = lexer->getStream())) {
+      int c;
+      while ((c = curStr->getChar()) != EOF) {
+	if (c == 'e' &&
+	    curStr->getBlock(endstreamBuf, 8) == 8 &&
+	    !memcmp(endstreamBuf, "ndstream", 8)) {
+	  length = curStr->getPos() - 9 - pos;
+	  foundEndstream = gTrue;
+	  break;
+	}
+      }
+    }
+    if (!foundEndstream) {
+      error(errSyntaxError, getPos(), "Couldn't find 'endstream' for stream");
+      delete baseStr;
+      return NULL;
+    }
+  }
 
-  // refill token buffers and check for 'endstream'
-  shift();  // kill '>>'
-  shift();  // kill 'stream'
-  if (buf1.isCmd("endstream")) {
-    shift();
-  } else {
-    error(getPos(), "Missing 'endstream'");
-    // kludge for broken PDF files: just add 5k to the length, and
-    // hope its enough
-    length += 5000;
+  // make new base stream
+  Stream *str = baseStr->makeSubStream(pos, gTrue, length, dict);
+
+  // look for the 'endstream' marker
+  if (haveLength) {
+    // skip over stream data
+    lexer->setPos(pos + length);
+
+    // check for 'endstream'
+    // NB: we never reuse the Parser object to parse objects after a
+    // stream, and we could (if the PDF file is damaged) be in the
+    // middle of binary data at this point, so we check the stream
+    // data directly for 'endstream', rather than calling shift() to
+    // parse objects
+    GBool foundEndstream = gFalse;
+    char endstreamBuf[8];
+    if ((curStr = lexer->getStream())) {
+      // skip up to 100 whitespace chars
+      int c;
+      for (int i = 0; i < 100; ++i) {
+	c = curStr->getChar();
+	if (!Lexer::isSpace(c)) {
+	  break;
+	}
+      }
+      if (c == 'e') {
+	if (curStr->getBlock(endstreamBuf, 8) == 8 &&
+	    !memcmp(endstreamBuf, "ndstream", 8)) {
+	  foundEndstream = gTrue;
+	}
+      }
+    }
+    if (!foundEndstream) {
+      error(errSyntaxError, getPos(), "Missing 'endstream'");
+      // kludge for broken PDF files: just add 5k to the length, and
+      // hope it's enough
+      // (dict is now owned by str, so we need to copy it before deleting str)
+      Object obj;
+      dict->copy(&obj);
+      delete str;
+      length += 5000;
+      str = baseStr->makeSubStream(pos, gTrue, length, &obj);
+    }
   }
 
-  // make base stream
-  str = baseStr->makeSubStream(pos, gTrue, length, dict);
+  // free the copied base stream
+  delete baseStr;
 
   // handle decryption
   if (fileKey) {
-    str = new DecryptStream(str, fileKey, encAlgorithm, keyLength,
-			    objNum, objGen);
+    // the 'Crypt' filter is used to mark unencrypted metadata streams
+    //~ this should also check for an empty DecodeParams entry
+    GBool encrypted = gTrue;
+    Object obj;
+    dict->dictLookup("Filter", &obj, recursion);
+    if (obj.isName("Crypt")) {
+      encrypted = gFalse;
+    } else if (obj.isArray() && obj.arrayGetLength() >= 1) {
+      Object obj2;
+      if (obj.arrayGet(0, &obj2)->isName("Crypt")) {
+	encrypted = gFalse;
+      }
+      obj2.free();
+    }
+    obj.free();
+    if (encrypted) {
+      str = new DecryptStream(str, fileKey, encAlgorithm, keyLength,
+			      objNum, objGen);
+    }
   }
 
   // get filters
-  str = str->addFilters(dict);
+  str = str->addFilters(dict, recursion);
 
   return str;
 }
```
---
























