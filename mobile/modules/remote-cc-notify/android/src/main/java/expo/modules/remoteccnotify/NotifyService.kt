package expo.modules.remoteccnotify

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.ServiceCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 常驻前台服务:维持一条到后端 /api/events 的 WebSocket,
 * 收到需要用户关注的事件就弹一条本地通知。
 *
 * 为什么非得是前台服务:App 退到后台后,系统随时可能回收进程,JS 侧那条连接也就没了。
 * 前台服务要靠一条常驻通知换进程存活 —— 这条通知是 Android 的硬性要求,不是可选项。
 *
 * 只在界面上明确开启时才会启动(默认关闭),因为它有可见代价。
 */
class NotifyService : Service() {

    companion object {
        private const val TAG = "RemoteCcNotify"
        private const val EXTRA_BASE_URL = "baseUrl"
        private const val EXTRA_TOKEN = "token"
        private const val PREFS = "remotecc.notify"
        private const val KEY_BASE_URL = "baseUrl"
        private const val KEY_TOKEN = "token"
        private const val MAX_BACKOFF_MS = 60_000L

        /** 给 JS 侧查状态用 */
        @Volatile
        var running: Boolean = false
            private set

        @Volatile
        var connected: Boolean = false
            private set

        @Volatile
        var lastError: String? = null
            private set

        fun start(context: Context, baseUrl: String, token: String) {
            val intent = Intent(context, NotifyService::class.java).apply {
                putExtra(EXTRA_BASE_URL, baseUrl)
                putExtra(EXTRA_TOKEN, token)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, NotifyService::class.java))
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val stopped = AtomicBoolean(false)
    private var retryAttempt = 0
    private var socket: WebSocket? = null
    private var baseUrl: String = ""
    private var token: String = ""

    private val client: OkHttpClient = OkHttpClient.Builder()
        // 服务端每 20 秒发 ping,这里设了 pingInterval 让 OkHttp 也做心跳,
        // 这样"连接悄悄死了"能在几十秒内被发现,而不是等下一次事件才发现
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifications.ensureChannels(this)
        running = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 进程被系统回收后按 START_STICKY 重拉时,intent 是 null。
        // 这时要用上次存下来的地址重连,否则常驻就断在这儿了。
        val url = intent?.getStringExtra(EXTRA_BASE_URL) ?: prefs().getString(KEY_BASE_URL, null)
        val tok = intent?.getStringExtra(EXTRA_TOKEN) ?: prefs().getString(KEY_TOKEN, null)

        if (url.isNullOrBlank() || tok.isNullOrBlank()) {
            lastError = "没有可用的电脑地址或 token,常驻连接无法启动"
            stopSelf()
            return START_NOT_STICKY
        }

        baseUrl = url
        token = tok
        prefs().edit().putString(KEY_BASE_URL, url).putString(KEY_TOKEN, tok).apply()

        // 必须在几秒内转前台,否则系统会直接杀掉
        goForeground()
        stopped.set(false)
        connect()

        return START_STICKY
    }

    override fun onDestroy() {
        stopped.set(true)
        handler.removeCallbacksAndMessages(null)
        runCatching { socket?.close(1000, "service stopped") }
        socket = null
        connected = false
        running = false
        super.onDestroy()
    }

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun goForeground() {
        val notification = Notifications.buildServiceNotification(this)
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        } else {
            0
        }
        ServiceCompat.startForeground(this, Notifications.SERVICE_NOTIFICATION_ID, notification, type)
    }

    private fun eventStreamUrl(): String {
        val ws = baseUrl
            .replaceFirst("http://", "ws://")
            .replaceFirst("https://", "wss://")
            .trimEnd('/')
        return "$ws/api/events?token=${URLEncoder.encode(token, "UTF-8")}"
    }

    private fun connect() {
        if (stopped.get()) return
        val request = Request.Builder().url(eventStreamUrl()).build()

        socket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    connected = true
                    lastError = null
                    retryAttempt = 0
                    Log.i(TAG, "事件流已连接")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleEvent(text)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    connected = false
                    Log.i(TAG, "事件流被关闭 code=$code reason=$reason")
                    scheduleReconnect()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    connected = false
                    lastError = t.message ?: t.javaClass.simpleName
                    Log.w(TAG, "事件流断开: $lastError")
                    scheduleReconnect()
                }
            },
        )
    }

    /** 退避重连:2s、4s、6s…最多 60s。手机切网络时会断,这是正常路径而不是异常 */
    private fun scheduleReconnect() {
        if (stopped.get()) return
        retryAttempt++
        val delay = minOf(MAX_BACKOFF_MS, 2_000L * retryAttempt)
        handler.postDelayed({ connect() }, delay)
    }

    private fun handleEvent(text: String) {
        try {
            val json = JSONObject(text)
            if (json.optString("t") != "notify") return
            val title = json.optString("title").ifBlank { "远程cc" }
            val body = json.optString("body")
            val link = json.optString("link").takeIf { it.isNotBlank() }
            // kind 决定通知落在哪个 id 区间,好让 App 侧能按类整段取消(审批完清 approval、
            // 进前台清 done)。取不到就当普通"可查看消息"处理
            val kind = json.optString("kind").takeIf { it.isNotBlank() }
            Notifications.postEvent(this, title, body, link, kind)
        } catch (e: Throwable) {
            Log.w(TAG, "事件解析失败: ${e.message}")
        }
    }
}
