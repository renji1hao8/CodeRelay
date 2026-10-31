package expo.modules.remoteccnotify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * 通知的公共部分:渠道、权限、深链、以及两种通知的构造。
 *
 * 渠道分成两类是有意的:常驻服务那条是 IMPORTANCE_MIN(不出声、不弹横幅、折叠在通知栏底部),
 * 事件通知是 IMPORTANCE_HIGH(要能立刻看见)。混在一个渠道里就做不到这个区分。
 */
internal object Notifications {

    /**
     * ⚠️ **事件渠道的 id 带了个 2,不是手滑。**
     *
     * Android 的渠道一旦创建就**不可变** —— `createNotificationChannel` 对已存在的 id
     * 只更新名字和描述,**优先级、声音、震动一律不再生效**。所以只要历史上有过一版用
     * 低优先级建的 `remotecc.events`,后面代码里把它改成 IMPORTANCE_HIGH 也是白改:
     * 使用者的机器上那条渠道仍然是老的设置,表现就是「审批通知静默出现在通知栏里、
     * 不弹横幅」(他 2026-09-20 的原话)。
     *
     * 换 id 是唯一能让新优先级真正落地的办法。旧的那条在 ensureChannels 里顺手删掉,
     * 免得它一直挂在系统的通知设置里让人困惑。
     */
    const val CHANNEL_EVENTS = "remotecc.events2"
    private const val CHANNEL_EVENTS_LEGACY = "remotecc.events"
    const val CHANNEL_SERVICE = "remotecc.service"

    /** 常驻通知的固定 id;事件通知用下面那些区间里的递增 id */
    const val SERVICE_NOTIFICATION_ID = 0xC001

    /**
     * 事件通知的 id 分区间。
     *
     * 原来用的是 `System.currentTimeMillis()` —— 后果是**每条事件都是新通知,只增不减**
     * 地堆在通知栏里,而且没有任何东西会去取消它们:审批完了、消息看过了,通知还赖着。
     * `setAutoCancel` 只在"点击通知本身"那一下生效,而使用者往往是从 App 里进去的,
     * 碰不到那一次点击。
     *
     * 改成按 kind 分区间的递增 id,换来两件事:
     *   1. 可以**按区间整段取消** —— 不必记住发过哪些 id,进程被杀重启也不会丢
     *   2. 每个区间最多 256 条,超出就覆盖最旧的,天然有上限
     */
    private const val ID_APPROVAL_BASE = 0x1000
    private const val ID_DONE_BASE = 0x2000
    private const val ID_TEST_BASE = 0x3000
    private const val ID_SPAN = 0x100

    private val idCursor = mutableMapOf<Int, Int>()

    private fun baseFor(kind: String?): Int = when (kind) {
        "approval" -> ID_APPROVAL_BASE
        "test" -> ID_TEST_BASE
        // done / error / 其它都归"有结果可以看了"这一类
        else -> ID_DONE_BASE
    }

    private fun nextEventId(kind: String?): Int {
        val base = baseFor(kind)
        val n = ((idCursor[base] ?: 0) + 1) % ID_SPAN
        idCursor[base] = n
        return base + n
    }

    /**
     * 取消已经弹过的事件通知。
     *
     * @param kind 只取消这一类(和 NotifyEvent 的 kind 同域);传 null 全清。
     *             **常驻那条永远不动** —— 它是前台服务的硬性要求,取消会让服务被判定非法。
     */
    fun clearEvents(context: Context, kind: String?) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val bases = if (kind == null) {
            listOf(ID_APPROVAL_BASE, ID_DONE_BASE, ID_TEST_BASE)
        } else {
            listOf(baseFor(kind))
        }
        val active = try {
            manager.activeNotifications
        } catch (_: Throwable) {
            return
        }
        for (n in active) {
            if (n.id == SERVICE_NOTIFICATION_ID) continue
            if (bases.any { n.id >= it && n.id < it + ID_SPAN }) manager.cancel(n.id)
        }
    }

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return

        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_EVENTS, "任务与审批", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "任务完成、需要你批准、或者会话出错时提醒你"
                // 审批是要人立刻动手的,把横幅那几个开关显式打开 ——
                // 有些 ROM 只看这几个字段决定要不要弹横幅,不看 IMPORTANCE
                enableVibration(true)
                enableLights(true)
                setShowBadge(true)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_SERVICE, "常驻连接", NotificationManager.IMPORTANCE_MIN).apply {
                description = "保持与电脑的连接,让 App 退到后台也能收到消息"
                setShowBadge(false)
            },
        )

        // 旧 id 的那条(优先级改不动的那条)删掉,免得它留在系统设置里让人以为还有两个渠道。
        // 删不掉(比如已经被别的逻辑引用)也无所谓 —— 只是设置页多一行。
        runCatching { manager.deleteNotificationChannel(CHANNEL_EVENTS_LEGACY) }
    }

    /** API 33 起没有 POST_NOTIFICATIONS 授权的话,notify() 会被静默丢弃 */
    fun canPost(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun smallIcon(context: Context): Int {
        val appIcon = context.applicationInfo.icon
        return if (appIcon != 0) appIcon else android.R.drawable.stat_notify_sync
    }

    /** 点通知 → 打开 App,并把深链带过去 */
    private fun openAppIntent(context: Context, link: String?, requestCode: Int): PendingIntent? {
        val intent = if (link.isNullOrBlank()) {
            context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
        } else {
            Intent(Intent.ACTION_VIEW, Uri.parse(link)).apply {
                setPackage(context.packageName)
            }
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags = flags or PendingIntent.FLAG_IMMUTABLE
        }
        return PendingIntent.getActivity(context, requestCode, intent, flags)
    }

    /** 常驻通知:必须存在,否则前台服务会被系统判定为非法 */
    fun buildServiceNotification(context: Context): Notification {
        val builder = NotificationCompat.Builder(context, CHANNEL_SERVICE)
            .setSmallIcon(smallIcon(context))
            .setContentTitle("CodeRelay 正在保持连接")
            .setContentText("任务完成或需要你批准时会通知你")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)

        openAppIntent(context, null, 0)?.let { builder.setContentIntent(it) }
        return builder.build()
    }

    fun buildEventNotification(context: Context, title: String, body: String, link: String?): Notification {
        val builder = NotificationCompat.Builder(context, CHANNEL_EVENTS)
            .setSmallIcon(smallIcon(context))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            // 渠道决定"这类通知能不能弹",这两个决定"**这一次**要不要弹":
            // PRIORITY_MAX 拉满,再标成 CATEGORY_REMINDER(要人处理的事)。
            // 光有 IMPORTANCE_HIGH 的渠道,在部分 ROM 上仍然只静默落进通知栏。
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)

        openAppIntent(context, link, link?.hashCode() ?: 1)?.let { builder.setContentIntent(it) }
        return builder.build()
    }

    /**
     * 弹一条事件通知。返回 false 表示没有授权、被系统丢弃了。
     *
     * `kind` 决定它落在哪个 id 区间 —— 于是能按类整段取消(见 clearEvents)。
     */
    fun postEvent(
        context: Context,
        title: String,
        body: String,
        link: String?,
        kind: String? = null,
    ): Boolean {
        if (!canPost(context)) return false
        ensureChannels(context)
        return try {
            NotificationManagerCompat.from(context)
                .notify(nextEventId(kind), buildEventNotification(context, title, body, link))
            true
        } catch (_: SecurityException) {
            false
        }
    }
}
