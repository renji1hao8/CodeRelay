import { useKeyboardState } from "react-native-keyboard-controller";

/**
 * 读取原生键盘状态。页面只用它调整输入区小间距；整屏避让由 App 根部统一负责。
 */
export function useKeyboardHeight(): number {
  return useKeyboardState(state => state.isVisible ? state.height : 0);
}
