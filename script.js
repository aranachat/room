// ==================== امنیت و رمزنگاری ====================
const CRYPTO_KEY = 'AranaChatV4SecureKey!';
const SALT = 'CHAT_ARANA_SALT';

function encryptData(data) {
    // در نسخه واقعی باید از Web Crypto API استفاده کنید
    try {
        return btoa(encodeURIComponent(JSON.stringify(data)));
    } catch {
        return '';
    }
}

function decryptData(encrypted) {
    try {
        return JSON.parse(decodeURIComponent(atob(encrypted)));
    } catch {
        return null;
    }
}

// ==================== اعتبارسنجی داده‌ها ====================
function sanitizeInput(text, maxLength = 2000) {
    if (typeof text !== 'string') return '';
    
    // حذف تگ‌های HTML
    const div = document.createElement('div');
    div.textContent = text.substring(0, maxLength);
    return div.innerHTML.replace(/[<>]/g, '');
}

function validateMessageData(data) {
    if (!data || typeof data !== 'object') return false;
    
    const required = ['type', 'senderId', 'timestamp', 'messageId'];
    for (const field of required) {
        if (!data[field]) return false;
    }
    
    // محدودیت طول محتوا
    if (data.content && data.content.length > 5000) return false;
    
    // اعتبارسنجی timestamp
    const now = Date.now();
    const messageTime = data.timestamp;
    if (messageTime > now + 60000 || messageTime < now - 86400000) return false;
    
    return true;
}

// ==================== مدیریت اتصال ایمن ====================
class SecureConnection {
    constructor() {
        this.maxRetries = 3;
        this.retryDelay = 2000;
        this.connectionTimeout = 10000;
    }
    
    async createPeer(id, config = {}) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('اتصال timeout شد'));
            }, this.connectionTimeout);
            
            const peer = new Peer(id, {
                host: '0.peerjs.com',
                port: 443,
                path: '/',
                debug: 0,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:global.stun.twilio.com:3478' }
                    ]
                },
                ...config
            });
            
            peer.on('open', (id) => {
                clearTimeout(timeout);
                resolve(peer);
            });
            
            peer.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }
}

// ==================== مدیریت حافظه ====================
class MemoryManager {
    constructor(maxMessages = 200, maxImageSize = 5 * 1024 * 1024) {
        this.maxMessages = maxMessages;
        this.maxImageSize = maxImageSize;
        this.imageCache = new Map();
    }
    
    addImage(messageId, data) {
        // حذف تصاویر قدیمی اگر حافظه پر شده
        if (this.imageCache.size > 20) {
            const oldestKey = this.imageCache.keys().next().value;
            this.imageCache.delete(oldestKey);
        }
        this.imageCache.set(messageId, data);
    }
    
    cleanup() {
        // حذف تصاویر با بیش از 5 دقیقه عمر
        const now = Date.now();
        for (const [key, value] of this.imageCache.entries()) {
            if (now - value.timestamp > 300000) {
                this.imageCache.delete(key);
            }
        }
    }
}

// ==================== سیستم گزارش خطا ====================
class ErrorTracker {
    constructor() {
        this.errors = [];
        this.maxErrors = 50;
    }
    
    log(error, context = '') {
        const errorObj = {
            timestamp: Date.now(),
            message: error.message || error,
            context,
            stack: error.stack
        };
        
        this.errors.push(errorObj);
        
        if (this.errors.length > this.maxErrors) {
            this.errors.shift();
        }
        
        console.error('❌ خطا:', errorObj);
    }
    
    getRecentErrors() {
        return this.errors.slice(-10);
    }
}

// ==================== بهبود عملکرد ====================
function throttle(func, limit) {
    let inThrottle;
    return function() {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ==================== بهبود ارسال پیام ====================
async function sendSecureMessage(content) {
    if (!content || content.trim().length === 0) return;
    
    const messageData = {
        type: 'public_message',
        content: sanitizeInput(content),
        senderId: myPeerId,
        senderName: myVisibleName,
        timestamp: Date.now(),
        messageId: generateMessageId(),
        status: 'sending',
        replyTo: replyingTo ? {
            messageId: replyingTo.messageId,
            author: sanitizeInput(replyingTo.author),
            content: sanitizeInput(replyingTo.content)
        } : null,
        likes: [],
        dislikes: [],
        version: '1.0'
    };
    
    // اعتبارسنجی
    if (!validateMessageData(messageData)) {
        showNotification('خطا در داده پیام', 'error');
        return;
    }
    
    displayMessage(messageData, true, 'public');
    
    try {
        if (amIAdmin) {
            addToHistory(messageData);
            broadcastToAll(messageData, [myPeerId]);
            updateMessageStatus(messageData.messageId, 'delivered');
        } else {
            const adminConn = connections.get(currentAdminId);
            if (adminConn && adminConn.open) {
                adminConn.send(messageData);
            } else {
                throw new Error('اتصال به مدیر قطع است');
            }
        }
        
        cancelReply();
        return true;
    } catch (error) {
        console.error('خطا در ارسال پیام:', error);
        updateMessageStatus(messageData.messageId, 'failed');
        showNotification('ارسال پیام ناموفق بود', 'error');
        return false;
    }
}

// ==================== بهبود پردازش داده ورودی ====================
function handleIncomingData(data, fromPeerId) {
    // اعتبارسنجی اولیه
    if (!data || typeof data !== 'object') {
        console.warn('داده نامعتبر از:', fromPeerId);
        return;
    }
    
    // بررسی version
    if (data.version && data.version !== '1.0') {
        console.warn('ورژن نامشخص:', data.version);
    }
    
    // اعتبارسنجی peerId فرستنده
    if (data.senderId && data.senderId !== fromPeerId) {
        console.warn('جعل هویت احتمالی:', data.senderId, fromPeerId);
        return;
    }
    
    try {
        switch(data.type) {
            case 'request_registration':
                handleRegistrationRequest(data, fromPeerId);
                break;
            case 'register':
                handleUserRegistration(data, fromPeerId);
                break;
            case 'public_message':
                if (validateMessageData(data)) {
                    handlePublicMessage(data, fromPeerId);
                }
                break;
            case 'user_list':
                handleUserList(data, fromPeerId);
                break;
            case 'heartbeat':
                handleHeartbeat(data, fromPeerId);
                break;
            case 'message_status':
                handleMessageStatus(data, fromPeerId);
                break;
            case 'image_chunk':
                handleImageChunk(data, fromPeerId);
                break;
            case 'message_history_chunk':
                handleMessageHistoryChunk(data, fromPeerId);
                break;
            case 'message_reaction':
                handleMessageReaction(data, fromPeerId);
                break;
            case 'expired_messages':
                handleExpiredMessages(data, fromPeerId);
                break;
            case 'system_message':
                handleSystemMessage(data, fromPeerId);
                break;
            case 'admin_info':
                handleAdminInfo(data, fromPeerId);
                break;
            case 'redirect_to_admin1':
                handleRedirectToAdmin1(data, fromPeerId);
                break;
            case 'admin1_returned':
                handleAdmin1ReturnedMsg(data, fromPeerId);
                break;
            case 'sync_request':
                handleSyncRequest(data, fromPeerId);
                break;
            case 'auto_sync':
                handleAutoSync(data, fromPeerId);
                break;
            default:
                console.log('نوع پیام ناشناخته:', data.type);
        }
    } catch (error) {
        console.error('خطا در پردازش داده:', error, data);
        errorTracker.log(error, `handleIncomingData: ${data.type}`);
    }
}

// ==================== بهبود سیستم مدیران ====================
async function manageAdminSwitch() {
    if (amIAdmin && currentAdminName === 'admin2') {
        // بررسی هر 30 ثانیه برای بازگشت admin1
        const admin1Exists = await testConnectionToAdmin('admin1');
        if (admin1Exists) {
            showNotification('👑 ادمین اصلی برگشته است. انتقال مدیریت...', 'warning');
            
            // اطلاع به کاربران
            broadcastToAll({
                type: 'admin_switch',
                newAdmin: 'admin1',
                timestamp: Date.now(),
                message: 'مدیریت به ادمین اصلی منتقل شد'
            });
            
            // 10 ثانیه فرصت برای کاربران
            setTimeout(async () => {
                // انتقال تاریخچه اگر ممکن باشد
                await transferHistoryToAdmin1();
                
                // بستن اتصالات
                connections.forEach(conn => conn.close());
                connections.clear();
                
                // تبدیل به کاربر عادی
                amIAdmin = false;
                currentAdminName = 'admin1';
                wasConnectedToAdmin1 = true;
                
                if (peer) {
                    peer.destroy();
                }
                
                // اتصال به admin1
                await joinAsMember();
                
                showNotification('✅ شما اکنون یک کاربر عادی هستید', 'success');
            }, 10000);
        }
    }
}

async function transferHistoryToAdmin1() {
    // تلاش برای انتقال تاریخچه پیام‌ها به admin1
    try {
        const tempPeer = new Peer(`transfer_${Date.now()}`, {
            host: '0.peerjs.com',
            port: 443,
            path: '/'
        });
        
        return new Promise((resolve) => {
            tempPeer.on('open', () => {
                const admin1Conn = tempPeer.connect(`${GLOBAL_ROOM}_admin1`, {
                    metadata: { type: 'history_transfer' }
                });
                
                admin1Conn.on('open', () => {
                    admin1Conn.send({
                        type: 'history_transfer',
                        messages: messageHistory.slice(-100),
                        timestamp: Date.now(),
                        fromAdmin: currentAdminName
                    });
                    
                    setTimeout(() => {
                        admin1Conn.close();
                        tempPeer.destroy();
                        resolve(true);
                    }, 3000);
                });
                
                admin1Conn.on('error', () => {
                    tempPeer.destroy();
                    resolve(false);
                });
            });
            
            tempPeer.on('error', () => {
                resolve(false);
            });
        });
    } catch (error) {
        console.error('خطا در انتقال تاریخچه:', error);
        return false;
    }
}

// ==================== بهبود سیستم تصاویر ====================
function optimizeImageUpload(file) {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith('image/')) {
            reject(new Error('فقط تصویر مجاز است'));
            return;
        }
        
        if (file.size > 10 * 1024 * 1024) {
            reject(new Error('حداکثر حجم 10MB'));
            return;
        }
        
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                // محاسبه اندازه جدید
                let width = img.width;
                let height = img.height;
                
                // محدودیت اندازه
                const MAX_WIDTH = 1920;
                const MAX_HEIGHT = 1080;
                
                if (width > MAX_WIDTH) {
                    height = (height * MAX_WIDTH) / width;
                    width = MAX_WIDTH;
                }
                
                if (height > MAX_HEIGHT) {
                    width = (width * MAX_HEIGHT) / height;
                    height = MAX_HEIGHT;
                }
                
                canvas.width = width;
                canvas.height = height;
                
                // کشیدن تصویر با کیفیت مناسب
                ctx.drawImage(img, 0, 0, width, height);
                
                // تبدیل به فرمت WebP با کیفیت 75%
                const quality = 0.75;
                const optimizedData = canvas.toDataURL('image/webp', quality);
                
                resolve({
                    data: optimizedData,
                    width: width,
                    height: height,
                    originalSize: file.size,
                    optimizedSize: optimizedData.length,
                    compression: ((file.size - optimizedData.length) / file.size * 100).toFixed(1) + '%'
                });
            };
            
            img.onerror = reject;
            img.src = e.target.result;
        };
        
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ==================== راه‌اندازی سیستم بهبود یافته ====================
const memoryManager = new MemoryManager();
const errorTracker = new ErrorTracker();
const secureConnection = new SecureConnection();

async function initializeChat() {
    try {
        // بارگذاری تنظیمات
        loadExpirationSetting();
        
        // تنظیم event listeners
        setupEventListeners();
        
        // شروع سیستم مانیتورینگ
        startAdminMonitoring();
        
        // شروع پاکسازی دوره‌ای
        startCleanupInterval();
        
        console.log('✅ چت با امنیت بالا راه‌اندازی شد');
    } catch (error) {
        console.error('❌ خطا در راه‌اندازی:', error);
        errorTracker.log(error, 'initializeChat');
    }
}

function setupEventListeners() {
    // جلوگیری از کلیدهای میانبر مخرب
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            showNotification('ذخیره سازی خودکار فعال است', 'info');
        }
    });
    
    // مدیریت حافظه
    window.addEventListener('beforeunload', () => {
        if (amIAdmin) {
            saveMessageHistory();
        }
    });
    
    // رفع مشکل touch در موبایل
    document.addEventListener('touchstart', function() {}, {passive: true});
}

function startCleanupInterval() {
    setInterval(() => {
        memoryManager.cleanup();
        
        // حذف اتصالات مرده
        connections.forEach((conn, peerId) => {
            if (!conn.open) {
                connections.delete(peerId);
            }
        });
        
        // به‌روزرسانی UI
        updateUsersList();
    }, 60000);
}

// ==================== تغییرات در CSS برای امنیت بیشتر ====================
const secureStyles = `
/* جلوگیری از انتخاب متن */
* {
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
}

/* جلوگیری از کشیدن تصاویر */
img {
    -webkit-user-drag: none;
    -khtml-user-drag: none;
    -moz-user-drag: none;
    -o-user-drag: none;
    user-drag: none;
}

/* مخفی کردن عناصر حساس */
.hidden-element {
    display: none !important;
}

/* حفاظت از محتوا */
.protected-content {
    pointer-events: none;
}

/* استایل برای تصاویر امن */
.secure-image {
    max-width: 100%;
    border: 1px solid #333;
    border-radius: 8px;
    image-rendering: -webkit-optimize-contrast;
    image-rendering: crisp-edges;
}
`;

// اضافه کردن استایل‌های امنیتی
const styleEl = document.createElement('style');
styleEl.textContent = secureStyles;
document.head.appendChild(styleEl);

// ==================== تابع اصلی بهبود یافته ====================
async function loginImproved() {
    const usernameInput = document.getElementById('usernameInput');
    myVisibleName = sanitizeInput(usernameInput.value.trim(), 20);
    
    if (!myVisibleName || myVisibleName.length < 2) {
        showNotification('لطفاً نام معتبر وارد کنید (حداقل ۲ کاراکتر)', 'error');
        return;
    }
    
    // غیرفعال کردن دکمه
    const loginBtn = document.getElementById('loginBtn');
    loginBtn.disabled = true;
    const originalText = loginBtn.innerHTML;
    loginBtn.innerHTML = '<div class="loading"></div> در حال برقراری اتصال امن...';
    
    try {
        // پاکسازی ذخیره‌سازی
        clearStorageOnStart();
        
        showNotification('🔐 در حال برقراری اتصال امن...', 'info');
        
        // تست اتصال به admin1
        const admin1Exists = await testConnectionToAdmin('admin1');
        
        if (admin1Exists) {
            showNotification('✅ اتصال امن برقرار شد', 'success');
            wasConnectedToAdmin1 = true;
            currentAdminName = 'admin1';
            await joinAsMember();
        } else {
            showNotification('⚠️ در حال ثبت‌نام به عنوان ادمین پشتیبان...', 'warning');
            await becomeAdmin('admin1');
        }
        
        // راه‌اندازی سیستم
        await initializeChat();
        
    } catch (error) {
        console.error('خطا در ورود:', error);
        errorTracker.log(error, 'loginImproved');
        showNotification('خطا در برقراری اتصال', 'error');
        
        // بازنشانی دکمه
        loginBtn.disabled = false;
        loginBtn.innerHTML = originalText;
    }
}

// جایگزینی تابع login اصلی
window.login = loginImproved;

// ==================== تابع بهبود یافته ارسال پیام ====================
function sendMessageImproved() {
    const input = document.getElementById('messageInput');
    const content = input.value.trim();
    
    if (!content) {
        showNotification('پیام نمی‌تواند خالی باشد', 'warning');
        return;
    }
    
    // محدودیت نرخ ارسال
    const now = Date.now();
    const lastMessageTime = window.lastMessageTime || 0;
    if (now - lastMessageTime < 1000) { // 1 ثانیه
        showNotification('لطفاً بین ارسال پیام‌ها کمی صبر کنید', 'warning');
        return;
    }
    window.lastMessageTime = now;
    
    // ارسال پیام
    sendSecureMessage(content).then(success => {
        if (success) {
            input.value = '';
            autoResize(input);
            
            if (isMobile) {
                input.blur();
            }
        }
    });
}

// جایگزینی تابع ارسال
window.sendMessage = sendMessageImproved;

// ==================== بهبود عملکرد در موبایل ====================
function optimizeForMobile() {
    if (!isMobile) return;
    
    // کاهش انیمیشن‌ها
    const style = document.createElement('style');
    style.textContent = `
    @media (max-width: 768px) {
        * {
            animation-duration: 0.3s !important;
            transition-duration: 0.3s !important;
        }
        
        .message-container {
            animation: fadeIn 0.2s ease !important;
        }
        
        .notification {
            animation: notificationIn 0.2s ease !important;
        }
    }
    `;
    document.head.appendChild(style);
    
    // بهبود عملکرد touch
    let lastTouchEnd = 0;
    document.addEventListener('touchend', (event) => {
        const now = Date.now();
        if (now - lastTouchEnd < 300) {
            event.preventDefault();
        }
        lastTouchEnd = now;
    }, false);
}

// راه‌اندازی بهینه‌سازی موبایل
optimizeForMobile();
