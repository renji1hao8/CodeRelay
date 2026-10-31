package expo.modules.remoteccnotify

import android.content.Intent
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * 后台通知的 JS 契约。
 *
 * 权限不在这里要 —— 由 JS 侧调 React Native 的 PermissionsAndroid 申请 POST_NOTIFICATIONS,
 * 对应的 uses-permission 已在模块的 AndroidManifest 里声明。
 */
class RemoteCcNotifyModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("RemoteCcNotify")

        /** 给界面用:模块在不在、服务跑没跑、流连上没、通知能不能弹 */
        Function("getStatus") {
            val context = appContext.reactContext
            mapOf(
                "available" to true,
                "running" to NotifyService.running,
                "connected" to NotifyService.connected,
                "canPost" to (context != null && Notifications.canPost(context)),
                "lastError" to NotifyService.lastError,
            )
        }

        AsyncFunction("start") { baseUrl: String, token: String ->
            val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
            Notifications.ensureChannels(context)
            NotifyService.start(context, baseUrl, token)
        }

        AsyncFunction("stop") {
            val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
            NotifyService.stop(context)
        }

        /** 前台模式下由 JS 直接弹一条通知(不依赖常驻服务) */
        AsyncFunction("notify") { title: String, body: String, link: String?, kind: String? ->
            val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
            Notifications.postEvent(context, title, body, link, kind)
        }

        /**
         * 取消已经弹过的事件通知 —— 通知栏里那堆"审批完了还赖着"的条目靠它清掉。
         *
         * JS 侧在两个时机调:
         *   - 审批被处理后:clearEvents("approval")
         *   - App 回到前台后:clearEvents("done")(那些是"有结果可以看了"的提醒,
         *     人已经进来了就算看过了)
         *
         * 传 null 全清。**常驻那条不受影响** —— 它是前台服务的硬性要求。
         */
        AsyncFunction("clearEvents") { kind: String? ->
            val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
            Notifications.clearEvents(context, kind)
        }

        /** 没给通知权限时,把用户送到本应用的系统通知设置页 */
        AsyncFunction("openNotificationSettings") {
            val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
            val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
    }
}
