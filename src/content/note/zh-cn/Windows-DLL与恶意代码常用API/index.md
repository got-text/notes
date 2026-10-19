---
title: Windows 底层机制与恶意代码常用 API
timestamp: 2026-10-19 10:23:00+08:00
toc: true
tags: [AI_Editing, Windows, Windows/dll]
---
# Windows 底层机制与恶意代码常用 API

> **用途**：不只是"查表"，而是理解**这些 DLL/API 背后系统在做什么**——这样才能在导入表被清空、函数名被抹掉时仍然推断出样本意图。
> **适用环境**：Windows XP SP3 / Windows 7（PMA labs 场景）。标 ⚠️ 的是版本差异点。
> **相关笔记**：<a href="/notes/note/zh-cn/xp-分析机-工具版本清单">XP-分析机-工具版本清单</a>

## 速览

| 节 | 内容 | 什么时候用 |
|---|---|---|
| 一 | 用法：三步定位 | 拿到样本先看这里 |
| 二 | **系统分层**：一个 API 从调用到内核的全过程 | 想搞清"谁在替谁干活" |
| 三 | **各子系统底层机制 + API 对照**（3.1–3.11） | 主体：机制怎么运转、对应哪些 API |
| 四 | 行为簇 → API | 给导入项贴标签、形成假设 |
| 五 | API 组合模板 | 想快速下判断时 |
| 六 | 导入表"看不见"的四种手段 | 导入表太"干净"时 |

**DLL 索引**（要查某个 DLL 直接跳到对应小节）

| DLL | 去哪看 | DLL | 去哪看 |
|---|---|---|---|
| `ntdll` / `kernel32` / `kernelbase` | 二、3.1、3.2 | `ws2_32` / `wininet` / `winhttp` / `urlmon` / `dnsapi` | 3.7 |
| `advapi32` | 3.4 / 3.5 / 3.6 / 3.11 | `user32` / `gdi32` / `gdiplus` | 3.9 |
| `psapi` / `shell32` / `dbghelp` | 3.1、3.6 | `ole32` / `oleaut32` / WMI | 3.10 |
| `userenv` / `netapi32` / `mpr` | 3.6 | `bcrypt` / `ncrypt` | 3.11 |
| `msvcrt` / `msvcrXX` | 3.1（末尾） | `winsta` / `wtsapi32` | 3.6 |

---

## 一、用法：三步定位

1. **列出来**：用 PEview / Dependency Walker / IDA 打开导入表，抄下 DLL 和函数（DW 会自动把序号还原成名字）
2. **贴标签**：按第四节的"行为簇"归类 → 形成假设
3. **下判断**：按第五节的"组合模板"匹配 → 假设升级为判断
4. **去验证**：字符串（IP / 域名 / 路径）→ 反汇编（看参数）→ 动态（Procmon + FakeNet/ApateDNS + Wireshark）

> **三条心法**
> - 导入表回答"**它能做什么**"，不回答"**它一定做什么**"。
> - **导入表干净 ≠ 行为干净**：见第二节 2.3 与第六节。
> - **不要只记 API 名，要记"它在系统里动了什么"**——同一个行为可以走好几条 API 路径（这正是第三节要讲的事）。

---

## 二、系统分层：一个 API 从调用到内核的全过程

### 2.1 四层结构

```
        恶意样本 / 应用程序
                │  调用 Win32 API
                ▼
  子系统 DLL：kernel32 / advapi32 / user32 / ws2_32 / ole32 …
     （多数只是"转发壳"：内部直接跳转到 ntdll）
                │  调用 Native API
                ▼
  ntdll.dll —— Nt*/Zw*/Rtl*/Ldr*，用户态最底层
                │  sysenter（x86）/ syscall（x64）
                ▼
  内核 ntoskrnl.exe：系统服务分发（SSDT）→ 执行体 → 驱动 → 硬件
```

一个完整例子：

```
kernel32!CreateFileW  →  ntdll!NtCreateFile  →  内核 NtCreateFile（I/O 管理器 → 文件系统驱动）
```

⚠️ **Win7 起**：`kernel32` 的实现被挪到 `kernelbase.dll`，`kernel32` 只剩转发壳；XP 上没有 `kernelbase`。

**对分析的意义**：导入 `kernel32!CreateFile` 和导入 `ntdll!NtCreateFile` 是**同一件事的两个层次**。后者出现在导入表里，通常意味着作者想绕过用户态层面的监控（hook / API 记录）。

### 2.2 三个"为什么"

| 问题 | 原因 |
|---|---|
| 为什么恶意代码爱直接调 `ntdll`？ | ① 绕过在 `kernel32`/`kernelbase` 层做的用户态 hook；② 名字更"底层"，行为更隐蔽 |
| 为什么 shellcode 里不能硬编码系统调用号？ | syscall 号由**内核版本**决定（SSDT 里的表项编号），跨 Windows 版本会变，硬编码必然翻车 |
| 为什么"导入表很干净"的样本依然什么都干得了？ | 见 2.3：导入表在结构上就可以被清空 |

### 2.3 加载器与导入表：PE 装载时到底发生了什么

PE 装载时，`ntdll` 里的加载器（`Ldrp*` 一族）会：

1. 读**导入目录**（`.idata`），拿到"我需要哪些 DLL"
2. 对每个 DLL 调用加载（`LdrLoadDll`）→ 拿到模块基址
3. 遍历**导入 thunk**，**逐个填充 IAT（导入地址表）**：
   - **按名字导入**：拿 `IMAGE_IMPORT_BY_NAME.Name`，去目标 DLL 的**导出名字表**（按字母排序）里二分查找。
     ⚠️ `Hint` 只是"从第几项开始找"的提示，**不决定结果**（新手最常误解的地方）。
   - **按序号导入**：直接用 `序号 − 导出基址` 去索引**导出地址表（EAT）**，**根本不需要名字**。

**所以两件事同时成立**：

- "序号导入"之所以能成立 → 因为 IAT 填充时**名字本来就不是必需的**（名字只是导出表里的一个可选字段）。
- "序号仍然可以还原成名字" → 只要那份 DLL 的导出表里**同时有名字**，就能反查。

**运行时动态解析**（`LoadLibrary` + `GetProcAddress`）绕过了整个 IAT 机制：导入表里只留下 `LoadLibrary`/`GetProcAddress` 这两三条，真实用到的函数在运行时才查出来（`GetProcAddress` 内部同样是查导出表，按名或按序号都行）。

**对分析的意义**：导入表是"静态可见的意图"，但它**在结构上就可能被清空** → 必须配合字符串、反汇编、动态验证。

---

## 三、各子系统底层机制 + API 对照

### 3.1 进程与线程

**机制**：进程是内核对象（EPROCESS），自带一个**句柄表**、一个虚拟地址空间、一个 PEB；线程（ETHREAD/TEB）是**调度单位**，有自己的寄存器和栈。

**创建流程**：`CreateProcess` → 用户态准备（STARTUPINFO 等）→ `NtCreateUserProcess`（⚠️ Vista+；XP 是 `NtCreateProcessEx` + `NtCreateThread`）→ 内核建立进程对象、映射映像、创建主线程 → 用户态初始化（加载 ntdll、填 IAT、调用入口点）。

**注入三法的机制差别**（这是"注入"章节的底层答案）：

| 手法 | 底层在做什么 |
|---|---|
| 远程线程 | 在目标进程空间分配内存 → 写代码 → 让内核在其中创建线程执行 |
| APC 注入 | 把回调挂进目标线程的 **APC 队列**，等该线程进入"可警报等待"时执行（不新建线程，更隐蔽） |
| 进程镂空 | 挂起创建 → `NtUnmapViewOfSection` 卸掉原映像 → 在**原映像基址**写入自己的 PE → 改线程上下文指向新入口 → 恢复 |

| DLL / API | 对应机制 |
|---|---|
| `kernel32`：`CreateProcess` / `ShellExecute` / `WinExec` | 创建进程（`ShellExecute` 走 Shell 解析，`WinExec` 是老接口） |
| `kernel32`：`CreateToolhelp32Snapshot` + `Process32First/Next` | 遍历进程/线程/模块快照（枚举） |
| `kernel32`：`OpenProcess` / `ReadProcessMemory` / `VirtualAllocEx` / `WriteProcessMemory` / `CreateRemoteThread` | 跨进程读写与执行（注入的零件） |
| `kernel32`：`GetThreadContext` / `SetThreadContext` / `SuspendThread` / `ResumeThread` | 操作线程上下文（镂空必备） |
| `kernel32`：`QueueUserAPC` | APC 注入 |
| `kernel32`：`CreateThread` / `WaitForSingleObject` / `TerminateProcess` | 本地线程与同步 |
| `psapi`：`EnumProcesses` / `EnumProcessModules` / `GetModuleFileNameEx` | 进程/模块枚举（信息收集，常用来找分析工具） |
| `ntdll`：`NtQueryInformationProcess` / `NtUnmapViewOfSection` / `NtQueueApcThread` / `NtCreateThreadEx` | 更底层、更隐蔽的同类操作 |
| `msvcrt` / `msvcrXX` | C 运行时（`malloc`/`memcpy`/`strcmp`/`_beginthreadex`）→ 顺带识别编译器与 CRT 版本 |

**意义**：`OpenProcess` 请求的**权限掩码**（如 `PROCESS_VM_WRITE` + `PROCESS_CREATE_THREAD`）本身就是"我要注入"的前置证据。

### 3.2 内存管理

**机制**：虚拟地址空间按**页**（4 KB）管理。`VirtualAlloc` 分两步：**reserve**（保留一段地址范围）+ **commit**（提交到物理内存）；每页有**保护属性**（R / RW / RX / RWX）。内核层有两道防护：**DEP**（禁止在非可执行页执行代码）与 **ASLR**（随机化模块基址）。

`VirtualAllocEx` = 在**别的进程**里分配；`VirtualProtectEx` = 改保护属性。这两件事是注入链条的第一和第三步。

**意义**：**"不属于任何模块、且属性为可执行可写（RWX）的内存"是注入的经典指纹**——这也是 Volatility 的 `malfind`、内存扫描工具的核心判据。

### 3.3 对象与句柄

**机制**：所有内核对象（进程、线程、文件、注册表键、事件、互斥体…）都通过**句柄**访问。句柄只是"进程句柄表里的一个索引"，而**权限在句柄里**（access mask）。拿不到权限就打不开对象。

- `DuplicateHandle` / `DuplicateTokenEx`：**跨进程复制句柄**（令牌盗用的基础）
- 句柄泄漏/忘记关闭也是样本的常见破绽（`OpenProcess` 后不 `CloseHandle`）

### 3.4 注册表

**机制**：注册表是**内核对象的命名空间**，底层是若干 **hive 文件**（`HKLM` 下的 `SYSTEM`、`SOFTWARE`、`SAM`、`SECURITY`，以及每个用户的 `NTUSER.DAT`），由内核挂载成树。`Reg*` API 就是在这个树上操作对象。

**自启注入点及其加载时机**（关键在"谁在什么时候读它"）：

| 位置 | 谁在何时读 | 说明 |
|---|---|---|
| `...\CurrentVersion\Run` / `RunOnce` | 登录时由 Explorer / userinit | 最常见 |
| `Winlogon\Userinit` / `Winlogon\Shell` | 登录过程由 `winlogon.exe` | 更早、更高权限 |
| `Image File Execution Options\<exe>\Debugger` | 每次**启动该 exe** 时由内核/加载器 | 劫持进程创建（"调试器"实为攻击载荷） |
| `AppInit_DLLs` | `user32.dll` 初始化时 | ⚠️ Win8+ 默认关闭（`LoadAppInit_DLLs`） |
| `Services\<名称>` | 由 SCM 读取（见 3.5） | 服务型持久化 |

| API | 机制 |
|---|---|
| `RegOpenKeyEx` / `RegCreateKeyEx` / `RegSetValueEx` / `RegQueryValueEx` / `RegDeleteKey` | 常规键值读写（持久化/配置） |
| `RegLoadKey` / `RegSaveKey` / `RegRestoreKey` | **挂载 / 导出 / 还原整个 hive**：能碰别人的用户配置，甚至绕过部分权限限制 |

**意义**：看到注册表 API，不要只说"写了注册表"——**要回答"写在哪个键上"**，因为键的位置决定了它**什么时候生效、以什么权限生效**。

### 3.5 服务与 SCM

**机制**：服务是"**以 SYSTEM 权限常驻**"的机制。服务数据库就是注册表 `HKLM\SYSTEM\CurrentControlSet\Services`；**服务控制管理器（SCM，`services.exe`）**负责按需启动与状态管理。`OpenSCManager` + `CreateService` + `StartService` = 往数据库里加一条 + 让 SCM 把它拉起来。

**意义**：样本偏爱服务的理由是**一次拿到 {持久化 + 高权限}**；这也解释了为什么很多 lab 里"清除服务"要连带删注册表键、而不是只 `sc stop/delete`。

### 3.6 安全模型：令牌 / SID / 完整性 / 会话

**机制**：每个进程持有一个**访问令牌（token）**，里面有 SID（用户/组）、**权限列表（privileges）**、**完整性级别**（⚠️ Vista+ 才引入 IL）。`OpenProcessToken` 打开自己的令牌，`AdjustTokenPrivileges` 只是把令牌里"**已经存在但未启用**"的权限打开——**不是凭空获得权限**。

| 关键点 | 解释 |
|---|---|
| `SeDebugPrivilege` | 可**绕过 DACL 打开任意进程**（读取/转储 LSASS 的前置条件） |
| `DuplicateTokenEx` + `CreateProcessWithTokenW` | 复制别人的令牌并用来启动新进程 = "换身份执行" |
| `ImpersonateLoggedOnUser` / `LogonUser` | 模拟/登录（提权与横向常见） |
| 完整性级别（IL） | 中完整性进程写不了高完整性对象——UAC 时代"提权"要过的那道墙 |
| `dbghelp!MiniDumpWriteDump` | 进程内存转储（凭据窃取的经典手段） |
| `winsta` / `wtsapi32`（`WinStation*` / `WTSQueryUserToken`） | 会话操作（跨会话拿令牌） |
| `userenv` / `netapi32` / `mpr` | 用户目录定位 / 账户与共享操作 / 连接网络共享（**横向移动**常见） |

**意义**："提权"不等于漏洞利用——**大量样本只是把已有权限启用**，或者盗用别人的令牌。

### 3.7 网络栈

**机制（分层）**：

```
应用 → ws2_32.dll（Winsock API）
     → mswsock.dll / AFD（\Device\Afd，socket 的真正实现）
     → ⚠️ XP：TDI ｜ Vista+：WFP
     → tcpip.sys → 网卡
```

- 高层 HTTP：`wininet.dll`（老牌，带缓存/代理设置）与 `winhttp.dll`（较新，"更纯"的 HTTP 客户端）——**选哪个能反映样本年代与作者习惯**
- `urlmon!URLDownloadToFile`：一条封装到底的下载 API
- DNS 解析链：`gethostbyname` / `getaddrinfo` → **DNS Client 服务（`dnscache`）** → `dnsapi!DnsQuery_*`（改 hosts 也在这条链上）

| API | 对应机制 |
|---|---|
| `WSAStartup` / `socket` / `connect` / `send` / `recv` | Winsock 初始化与 TCP 收发（**最常被序号导入**） |
| `bind` / `listen` / `accept` | 监听（bind shell） |
| `WSASocket` / `WSAConnect` / `select` | 带参数扩展的套接字接口 |
| `InternetOpen` / `InternetOpenUrl` / `HttpOpenRequest` / `HttpSendRequest` / `InternetReadFile` | wininet 高层 HTTP |
| `WinHttpOpen` / `WinHttpConnect` / `WinHttpSendRequest` / `WinHttpReadData` | winhttp 高层 HTTP |
| `URLDownloadToFile` | 直接下载落盘 |
| `DnsQuery_A` / `DnsQuery_W` / `gethostbyname` / `getaddrinfo` | 域名解析（含 DNS 隧道） |
| `GetAdaptersInfo` / `GetIpAddrTable`（`iphlpapi`） | 收集本机网络信息 |
| `AcquireCredentialsHandle` / `InitializeSecurityContext`（`secur32`） | 认证 / 凭据相关 |

**意义**：为什么网络样本常**用序号导入 `ws2_32`**（省得暴露函数名）；以及为什么**劫持 DNS**（ApateDNS / INetSim）能通吃绝大多数样本。

### 3.8 文件系统与 I/O

**机制**：`CreateFile` 是"**万物皆文件**"的统一入口——同一个 API 能打开磁盘文件、命名管道 `\\.\pipe\x`、原始设备 `\\.\PhysicalDrive0`、甚至卷。内核统一走 I/O 管理器 → 文件系统驱动。

| 关键点 | 机制 |
|---|---|
| 文件映射 | `CreateFileMapping` + `MapViewOfFile` = 把文件当内存读写（大文件、加壳、dropper 常用） |
| 时间戳 | 创建/修改/访问时间存在 NTFS 的 **MFT 记录**里；`SetFileTime` 改的就是它（反取证） |
| 延迟自删 | `MoveFileEx(..., MOVEFILE_DELAY_UNTIL_REBOOT)` 会在注册表 `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager` 的 `PendingFileRenameOperations` 里**登记一条**，重启时由会话管理器执行 → **这条注册表值就是自删除样本的取证线索** |
| 管道通信 | `CreateNamedPipe` / `ConnectNamedPipe` / `PeekNamedPipe`（跨进程/跨会话，常与注入配合） |

**意义**：分析"落地文件"时要把三件事一起看：**路径**（`%TEMP%` / `%APPDATA%` / 系统目录）+ **时间戳** + **是否被映射执行**。

### 3.9 窗口消息与输入

**机制**：每个 GUI 线程有**消息队列**；`SetWindowsHookEx` 把回调挂到**钩子链**上：

- ⚠️ **全局低级钩子**（`WH_KEYBOARD_LL` / `WH_MOUSE_LL`）**不注入目标进程**，回调在**自己的进程**里执行——所以键盘记录器偏爱它（免注入、更难被裁掉）。
- 其他进程的普通钩子需要把 DLL **映射进目标进程**（老式 DLL 注入），受位数与会话限制。

| API | 机制 |
|---|---|
| `SetWindowsHookEx` | 挂钩子（LL 钩子 = 本进程回放；普通钩子 = 注入 DLL） |
| `GetAsyncKeyState` / `GetKeyState` | **轮询**全局/线程按键状态（不需要钩子） |
| `GetForegroundWindow` / `GetWindowText` | 记录"用户在哪个窗口"（键盘记录器常配套） |
| `BitBlt` / `GetDC` / `CreateCompatibleDC` / `CreateCompatibleBitmap` + `GdiplusStartup` | 经 GDI 把屏幕内容复制到内存位图，再编码成图片 |
| `FindWindow` / `EnumWindows` | 探测特定窗口（**找分析工具**、找浏览器） |

**意义**："窃密"章节的三条线路就是：**LL 钩子 / 轮询 / 截屏**。

### 3.10 COM 与 WMI

**机制**：COM 对象按 **CLSID** 注册在注册表（`InProcServer32` = DLL 内进程；`LocalServer32` = 独立进程，常由 `RPCSS` / SCM 拉起）。`CoCreateInstance` 按 CLSID 找到并**启动承载进程**。

WMI：`Win32_Process.Create` 由 WMI 提供者（`WmiPrvSE.exe`）**代理执行**——新进程的父进程**不是样本自己**（天然"甩锅"），而且支持远程执行。

| API | 机制 |
|---|---|
| `CoInitialize` / `CoCreateInstance` / `SysAllocString` | COM 激活与字符串（`ole32` / `oleaut32`） |
| `IWbmiLocator` → `Win32_Process.Create` | 借 WMI 创建进程（隐蔽、可远程） |

**意义**：导入表出现 `CoCreateInstance`，说明样本在用 COM——可能是 WMI、脚本宿主或计划任务。

### 3.11 加密

**机制（两代 API）**：

| 代 | 路径 | 特点 |
|---|---|---|
| **CryptoAPI** | `advapi32!CryptAcquireContext` → CSP（如 `rsaenh.dll`） | 密钥以 CSP 句柄形式存在；`CryptGenKey` / `CryptDeriveKey` 从口令派生密钥；`CryptEncrypt` / `CryptDecrypt` / `CryptCreateHash` / `CryptHashData` |
| **CNG** | `bcrypt.dll` / `ncrypt.dll` | 更现代的算法提供者模型；`BCryptEncrypt` / `BCryptDecrypt` / `BCryptGenRandom` |

⚠️ **很多样本故意不用系统加密 API**，自己实现 RC4 / XOR / AES —— 这样导入表里**没有任何加密痕迹**，也躲开 API 监控。这时只能靠**算法特征**识别：RC4 的 256 字节 S 盒初始化序列、AES 的 S-box（`0x637c777b`）、TEA/XTEA 的魔数 `0x9E3779B9`、ChaCha20 的 `expand 32-byte k`。

**意义**：**"导入表里没有加密 API"不能证明"没有加密"**。

---

## 四、行为簇 → API

> 读法：第三列"→"后面是**该去看什么**；机制细节回到对应小节。

### 4.1 代码执行与注入

| 行为 | 代表 API | 含义 → 下一步 | 机制 |
|---|---|---|---|
| 进程注入 | `OpenProcess` + `VirtualAllocEx` + `WriteProcessMemory` + `CreateRemoteThread` | 远程线程注入 → 找目标进程名 | 3.1 / 3.2 |
| 进程镂空 | `CreateProcess(SUSPENDED)` + `NtUnmapViewOfSection` + `SetThreadContext` + `ResumeThread` | 白加黑 → 找被替换的宿主进程 | 3.1 |
| APC 注入 | `QueueUserAPC` / `NtQueueApcThread` | 不建线程的注入 → 找目标线程 | 3.1 |
| DLL 注入 | `SetWindowsHookEx` / `LoadLibrary` + `CreateRemoteThread` | 老式注入 → 找被注入的 DLL | 3.9 |
| 动态解析 API | `LoadLibrary` + `GetProcAddress`（或 `LdrLoadDll` + `LdrGetProcedureAddress`） | 导入表被刻意"漂白" → 找字符串解密与调用点 | 2.3 |
| 命名管道通信 | `CreateNamedPipe` / `ConnectNamedPipe` / `CreateFile(\\.\pipe\...)` | 跨进程/跨会话通信 → 找管道名与对端 | 3.8 |

### 4.2 持久化

| 行为 | 代表 API | 含义 → 下一步 | 机制 |
|---|---|---|---|
| 注册表自启 | `RegCreateKeyEx` + `RegSetValueEx`（`Run` / `Winlogon` / `AppInit_DLLs` / `IFEO`） | 开机自启 → **先看键名，它决定生效时机** | 3.4 |
| 服务常驻 | `OpenSCManager` + `CreateService` + `StartService`（`ChangeServiceConfig` = 改了已有服务） | 持久化 + 高权限 → 看服务名与二进制路径 | 3.5 |

### 4.3 权限与身份

| 行为 | 代表 API | 含义 → 下一步 | 机制 |
|---|---|---|---|
| 提权 | `OpenProcessToken` + `LookupPrivilegeValue` + `AdjustTokenPrivileges` | 启用已有权限（如 `SeDebugPrivilege`）→ 看请求了哪些 | 3.6 |
| 盗用令牌 / 换身份 | `DuplicateTokenEx` + `CreateProcessWithTokenW` / `ImpersonateLoggedOnUser` | 用别人的身份执行 → 看令牌来源 | 3.6 |

### 4.4 网络

| 行为 | 代表 API | 含义 → 下一步 | 机制 |
|---|---|---|---|
| 反弹连接 / C2 | `WSAStartup` + `socket` + `connect` + `send`/`recv`（**没有 `listen`**） | 主动外连（后门/窃密）→ 看 `inet_addr`、`htons` 的参数与字符串里的 IP/域名 | 3.7 |
| 监听后门 | `bind` + `listen` + `accept` | 被动等待（bind shell）→ 看端口与防火墙改动 | 3.7 |
| 下载执行 | `URLDownloadToFile` / `InternetReadFile` + `ShellExecute`/`CreateProcess` | dropper → 看 URL 与落地路径 | 3.7 |

### 4.5 文件与反取证

| 行为 | 代表 API | 含义 → 下一步 | 机制 |
|---|---|---|---|
| 落地 / 自删 | `CreateFile` + `WriteFile`；`MoveFileEx(MOVEFILE_DELAY_UNTIL_REBOOT)` | 写文件、重启后自删 → 顺带查 `PendingFileRenameOperations` | 3.8 |
| 时间戳篡改 | `SetFileTime` | 伪造时间（反取证）→ 看被改的文件 | 3.8 |
| 离线操作 hive | `RegLoadKey` / `RegSaveKey` / `RegRestoreKey` | 挂载/导出注册表数据库 → 看 hive 路径 | 3.4 |

### 4.6 窃密

| 行为 | 代表 API | 含义 → 下一步 | 机制 |
|---|---|---|---|
| 键盘记录 | `GetAsyncKeyState` / `SetWindowsHookEx(WH_KEYBOARD_LL)` | 记录按键 → 看写入位置与回传方式 | 3.9 |
| 屏幕截取 | `BitBlt` / `GetDC` + `GdiplusStartup` | 截屏 → 看图片落盘/外传 | 3.9 |
| 凭据窃取 | `MiniDumpWriteDump`（针对 LSASS）/ `OpenProcessToken` | 转储凭据 → 看目标进程与落盘路径 | 3.6 |

### 4.7 反分析

| 行为 | 代表 API | 含义 → 下一步 | 机制 |
|---|---|---|---|
| 反调试 | `IsDebuggerPresent` / `CheckRemoteDebuggerPresent` / `NtQueryInformationProcess`(`ProcessDebugPort`/`Flags`) / `OutputDebugString` / `CloseHandle(无效句柄)` | 检测调试器 → 找判断分支，考虑打补丁或插件绕过 | 3.1 |
| 反虚拟机 | 注册表/文件/进程名探测、`GetSystemFirmwareTable`、CPUID、MAC 前缀、磁盘大小 | 检测分析环境 → 找判断分支与跳转 | 3.1 |
| 时序规避 | `GetTickCount` / `QueryPerformanceCounter` / `timeGetTime` / 超长 `Sleep` | 时间检测或拖延 → 看比较逻辑 | 3.1 |
| 地域门控 | `GetSystemDefaultLangID` / `GetLocaleInfo` / `GetTimeZoneInformation` | 只对特定地区发作 → 看被门控的行为 | 3.6 |

### 4.8 标记与辅助

| 行为 | 代表 API | 含义 → 下一步 | 机制 |
|---|---|---|---|
| 感染标记 | `CreateMutex` / `OpenMutex`（互斥体名） | 单实例/"是否已感染"判断 → **互斥体名是极好的 IOC** | 3.3 |

---

## 五、API 组合模板

| 组合 | 结论 |
|---|---|
| `OpenProcess` + `VirtualAllocEx` + `WriteProcessMemory` + `CreateRemoteThread` | 远程线程注入 |
| `CreateProcess(SUSPENDED)` + `NtUnmapViewOfSection` + `SetThreadContext` + `ResumeThread` | 进程镂空（Process Hollowing） |
| `LoadLibrary` + `GetProcAddress` 频繁出现 | 有意隐藏 API 使用 |
| `RegCreateKeyEx` + `RegSetValueEx`（`Run` 类键） | 注册表持久化 |
| `OpenSCManager` + `CreateService` + `StartService` | 服务持久化 |
| `InternetOpen` + `HttpOpenRequest` + `InternetReadFile` | HTTP 通信 / 下载 |
| `URLDownloadToFile` + `ShellExecute` / `CreateProcess` | 下载并执行（dropper） |
| `WSAStartup` + `socket` + `connect` + `send`/`recv` | 反弹连接后门 |
| `bind` + `listen` + `accept` | 监听型后门（bind shell） |
| `GetAsyncKeyState` + `SetWindowsHookEx` + 文件写入 | 键盘记录器 |
| `MoveFileEx` + `MOVEFILE_DELAY_UNTIL_REBOOT` | 重启自删（反取证） |
| `CreateProcess(SW_HIDE)` + `CreateNamedPipe` / `ConnectNamedPipe` | 隐蔽子进程 + 管道回传（常配合 shellcode） |

---

## 六、导入表"看不见"的四种手段

> 机制原理见 2.3：导入表是"装载时被填充的地址表"，它的内容可以被合法地清空。

| 手段 | 你在工具里看到什么 | 应对 |
|---|---|---|
| **① 序号导入** | 显示 `Ordinal_23` / `ws2_32_#23`，没有函数名 | 用**目标系统那份 DLL**的导出表还原（EAT + 名字表）；或查公开的序号表 |
| **② 动态解析** | 导入表只有 `LoadLibrary` / `GetProcAddress` | 找字符串解密代码、反汇编调用点，动态下断点看参数 |
| **③ API hashing** | 常量 + 循环（ROR13 / DJB2 / CRC32） | 用 hashdb 或自己实现该哈希算法反查函数名 |
| **④ 加壳 / 保护** | 导入表极小（常只有两个 API）、节区熵高、节名异常 | 先脱壳（OllyDbg + OllyDump / Scylla），或运行时 dump 后重建导入表 |
