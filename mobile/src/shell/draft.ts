/**
 * 命令框里那半条还没发出去的命令。
 *
 * ⚠️ 为什么要放在**模块级**变量里:App 的四个 tab 是**条件渲染**
 * (`{tab === "shell" ? <ShellScreen/> : null}`),切走就卸载,组件里的 `useState`
 * 跟着没。而「想跑个命令 → 切去会话页看一眼路径 → 切回来」恰恰是最常见的动作 ——
 * 半条命令没了会让人骂人。
 *
 * 和 `cache.ts` / `storage.ts` 是同一个套路,只是这份命更短:**杀进程就没了**,
 * 也不值得为它写进 SecureStore(那是给凭据和配置用的)。
 */
export const shellDraft = {
  command: "",
  cwd: "",
};
