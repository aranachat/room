// ==================== متغیرهای اصلی ====================
let peer = null;
let myVisibleName = '';
let myPeerId = '';
let currentAdminId = '';
let currentAdminName = 'admin1';
let amIAdmin = false;
let isMobile = window.innerWidth <= 768;

let connections = new Map();
let users = new Map();
let incomingImages = new Map();
let userColors = new Map();

let messageHistory = [];
const MAX_MESSAGES = 500; // کاهش تعداد پیام‌ها برای بهبود عملکرد

let messageExpirationMinutes = 5;
let expirationInterval = null;

let replyingTo = null;

const GLOBAL_ROOM = 'CHAT_ARANA_V4';
const ADMIN_NAMES = ['admin1', 'admin2']; // فقط دو ادمین
let isEmergencyMode = false;
let wasConnectedToAdmin1 = false;

let heartbeatInterval = null;
let reconnectInterval = null;
let adminCheckInterval = null;
let autoSyncInterval = null;

const USER_COLORS = [
    '#8a2be2', '#00ff88', '#00ffff', '#ffaa00',
    '#ff00ff', '#00ccff', '#ffff00', '#ff4444'
];

// ==================== پاک کردن کش در شروع ====================
function clearStorageOnStart() {
    try {
        localStorage.clear();
        sessionStorage.clear();
        console.log('✅ کش پاک شد');
    } catch (error) {
        console.error('خطا در پاک کردن کش:', error);
    }
}

// ==================== توابع کمکی ====================
function generatePeerId() {
    const randomStr = Math.random().toString(36).substr(2, 6);
    return `${GLOBAL_ROOM}_${Date.now()}_${randomStr}`;
}

function generateMessageId() {
    return `${myPeerId}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = 'notification';
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';
    if (type === 'warning') icon = '⚠️';
    if (type === 'admin') icon = '👑';
    
    notification.innerHTML = `
        <span>${icon}</span>
        <span>${message}</span>
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('fa-IR', {
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatDate(timestamp) {
    return new Date(timestamp).toLocaleDateString('fa-IR');
}

function getUserColor(peerId) {
    if (!userColors.has(peerId)) {
        const hash = peerId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        const colorIndex = hash % USER_COLORS.length;
        userColors.set(peerId, USER_COLORS[colorIndex]);
    }
    return userColors.get(peerId);
}

// ==================== سیستم حذف خودکار ====================
function selectExpiration(minutes) {
    messageExpirationMinutes = minutes;
    localStorage.setItem('chat_expiration', minutes);
    
    const options = document.querySelectorAll('.expiration-option');
    options.forEach(option => {
        option.classList.remove('selected');
        const radio = option.querySelector('div div');
        if (radio) radio.style.display = 'none';
    });
    
    const selectedOption = document.querySelector(`[onclick="selectExpiration(${minutes})"]`);
    if (selectedOption) {
        selectedOption.classList.add('selected');
        const radio = selectedOption.querySelector('div div');
        if (radio) radio.style.display = 'block';
    }
}

function loadExpirationSetting() {
    const saved = localStorage.getItem('chat_expiration');
    if (saved !== null) {
        messageExpirationMinutes = parseInt(saved);
    }
    selectExpiration(messageExpirationMinutes);
}

function startExpirationSystem() {
    if (expirationInterval) clearInterval(expirationInterval);
    if (messageExpirationMinutes === 0) return;
    
    expirationInterval = setInterval(() => {
        if (!amIAdmin) return;
        
        const now = Date.now();
        const expirationTime = messageExpirationMinutes * 60 * 1000;
        
        const expiredMessages = messageHistory.filter(msg => 
            (now - msg.timestamp) > expirationTime
        );
        
        if (expiredMessages.length > 0) {
            messageHistory = messageHistory.filter(msg => 
                (now - msg.timestamp) <= expirationTime
            );
            
            saveMessageHistory();
            
            broadcastToAll({
                type: 'expired_messages',
                messageIds: expiredMessages.map(m => m.messageId),
                timestamp: now
            });
            
            expiredMessages.forEach(msg => {
                const messageEl = document.getElementById(`msg_${msg.messageId}`);
                if (messageEl) {
                    messageEl.remove();
                }
            });
            
            updateStorageInfo();
        }
    }, 60000);
}

// ==================== مدیریت تاریخچه پیام‌ها ====================
function addToHistory(message) {
    messageHistory.push(message);
    
    if (messageHistory.length > MAX_MESSAGES) {
        messageHistory.shift();
    }
    
    if (amIAdmin) {
        saveMessageHistory();
    }
}

function saveMessageHistory() {
    try {
        const toSave = messageHistory.slice(-MAX_MESSAGES);
        localStorage.setItem('chat_message_history', JSON.stringify(toSave));
    } catch (e) {
        console.error('خطا در ذخیره تاریخچه:', e);
    }
}

function loadMessageHistory() {
    try {
        const saved = localStorage.getItem('chat_message_history');
        if (saved) {
            messageHistory = JSON.parse(saved);
        }
    } catch (e) {
        messageHistory = [];
    }
}

function updateStorageInfo() {
    const messageCountElement = document.getElementById('messageCount');
    if (messageCountElement) {
        messageCountElement.textContent = `${messageHistory.length} پیام`;
    }
}

// ==================== ارسال تاریخچه به کاربر جدید ====================
function sendMessageHistoryToUser(peerId) {
    if (!amIAdmin) return;
    
    const conn = connections.get(peerId);
    if (conn && conn.open && messageHistory.length > 0) {
        const chunk = messageHistory.slice(-50); // فقط 50 پیام آخر
        
        if (conn && conn.open) {
            conn.send({
                type: 'message_history_chunk',
                chunk: chunk,
                timestamp: Date.now()
            });
        }
    }
}

// ==================== سیستم لایک/دیسلایک ====================
function addReaction(messageId, reactionType) {
    const messageIndex = messageHistory.findIndex(msg => msg.messageId === messageId);
    if (messageIndex === -1) return;
    
    const message = messageHistory[messageIndex];
    
    if (!message.likes) message.likes = [];
    if (!message.dislikes) message.dislikes = [];
    
    const userLikedIndex = message.likes.indexOf(myPeerId);
    const userDislikedIndex = message.dislikes.indexOf(myPeerId);
    
    if (reactionType === 'like') {
        if (userLikedIndex > -1) {
            message.likes.splice(userLikedIndex, 1);
        } else {
            message.likes.push(myPeerId);
            if (userDislikedIndex > -1) {
                message.dislikes.splice(userDislikedIndex, 1);
            }
        }
    } else if (reactionType === 'dislike') {
        if (userDislikedIndex > -1) {
            message.dislikes.splice(userDislikedIndex, 1);
        } else {
            message.dislikes.push(myPeerId);
            if (userLikedIndex > -1) {
                message.likes.splice(userLikedIndex, 1);
            }
        }
    }
    
    messageHistory[messageIndex] = message;
    
    if (amIAdmin) {
        saveMessageHistory();
        broadcastToAll({
            type: 'message_reaction',
            messageId: messageId,
            likes: message.likes,
            dislikes: message.dislikes,
            timestamp: Date.now()
        });
    } else {
        const adminConn = connections.get(currentAdminId);
        if (adminConn && adminConn.open) {
            adminConn.send({
                type: 'message_reaction',
                messageId: messageId,
                likes: message.likes,
                dislikes: message.dislikes,
                timestamp: Date.now()
            });
        }
    }
    
    updateReactionUI(messageId, message.likes, message.dislikes);
}

function updateReactionUI(messageId, likes, dislikes) {
    const messageEl = document.getElementById(`msg_${messageId}`);
    if (!messageEl) return;
    
    const likeBtn = messageEl.querySelector('.reaction-btn.like-btn');
    const dislikeBtn = messageEl.querySelector('.reaction-btn.dislike-btn');
    
    if (likeBtn) {
        const likeCount = likes ? likes.length : 0;
        likeBtn.innerHTML = `👍 ${likeCount}`;
        likeBtn.classList.toggle('liked', likes && likes.includes(myPeerId));
    }
    
    if (dislikeBtn) {
        const dislikeCount = dislikes ? dislikes.length : 0;
        dislikeBtn.innerHTML = `👎 ${dislikeCount}`;
        dislikeBtn.classList.toggle('disliked', dislikes && dislikes.includes(myPeerId));
    }
}

// ==================== تست اتصال به مدیر ====================
async function testConnectionToAdmin(adminName) {
    return new Promise((resolve) => {
        const testPeer = new Peer(`test_${Date.now()}`, {
            host: '0.peerjs.com',
            port: 443,
            path: '/',
            debug: 0
        });
        
        testPeer.on('open', () => {
            const adminPeerId = `${GLOBAL_ROOM}_${adminName}`;
            const conn = testPeer.connect(adminPeerId, {
                reliable: true,
                metadata: { type: 'admin_test' }
            });
            
            const timeout = setTimeout(() => {
                conn.close();
                testPeer.destroy();
                resolve(false);
            }, 2000);
            
            conn.on('open', () => {
                clearTimeout(timeout);
                conn.close();
                testPeer.destroy();
                resolve(true);
            });
            
            conn.on('error', () => {
                clearTimeout(timeout);
                conn.close();
                testPeer.destroy();
                resolve(false);
            });
        });
        
        testPeer.on('error', () => {
            testPeer.destroy();
            resolve(false);
        });
    });
}

// ==================== سیستم لاگین ====================
async function login() {
    const usernameInput = document.getElementById('usernameInput');
    myVisibleName = usernameInput.value.trim();
    
    if (!myVisibleName || myVisibleName.length < 2) {
        showNotification('لطفاً نام معتبر وارد کنید (حداقل ۲ کاراکتر)', 'error');
        return;
    }
    
    clearStorageOnStart();
    
    const loginBtn = document.getElementById('loginBtn');
    loginBtn.disabled = true;
    loginBtn.innerHTML = '<div class="loading"></div> در حال اتصال...';
    
    showNotification('🔍 در حال جستجوی ادمین1...', 'info');
    
    const admin1Exists = await testConnectionToAdmin('admin1');
    
    if (admin1Exists) {
        showNotification('✅ ادمین1 پیدا شد', 'success');
        wasConnectedToAdmin1 = true;
        currentAdminName = 'admin1';
        await joinAsMember();
    } else {
        showNotification('⚠️ در حال ثبت‌نام به عنوان ادمین1...', 'warning');
        await becomeAdmin('admin1');
    }
}

// ==================== تبدیل به ادمین ====================
async function becomeAdmin(adminName) {
    currentAdminName = adminName;
    myPeerId = `${GLOBAL_ROOM}_${adminName}`;
    currentAdminId = myPeerId;
    
    try {
        peer = new Peer(myPeerId, {
            host: '0.peerjs.com',
            port: 443,
            path: '/',
            debug: 0
        });
        
        peer.on('open', (id) => {
            console.log(`✅ شما ${adminName} شدید`);
            amIAdmin = true;
            wasConnectedToAdmin1 = (adminName === 'admin1');
            
            setupAsAdmin();
        });
        
        peer.on('error', (err) => {
            console.error(`خطا در ثبت‌نام به عنوان ${adminName}:`, err);
            
            if (err.type === 'unavailable-id') {
                if (adminName === 'admin1') {
                    showNotification('⚡ ادمین1 گرفته شده! تلاش برای اتصال...', 'info');
                    setTimeout(async () => {
                        const exists = await testConnectionToAdmin('admin1');
                        if (exists) {
                            joinAsMember();
                        } else {
                            becomeAdmin('admin2');
                        }
                    }, 2000);
                } else if (adminName === 'admin2') {
                    showNotification('❌ هر دو ادمین گرفته شده‌اند!', 'error');
                    setTimeout(() => {
                        document.getElementById('loginBtn').disabled = false;
                        document.getElementById('loginBtnText').textContent = '🚀 ورود به چت';
                    }, 2000);
                }
            }
        });
        
    } catch (error) {
        console.error('خطا در becomeAdmin:', error);
        setTimeout(() => becomeAdmin(adminName), 2000);
    }
}

// ==================== تبدیل به عضو ====================
async function joinAsMember() {
    myPeerId = generatePeerId();
    
    try {
        peer = new Peer(myPeerId, {
            host: '0.peerjs.com',
            port: 443,
            path: '/',
            debug: 0
        });
        
        peer.on('open', (id) => {
            console.log('✅ عضو ایجاد شد');
            setupAsMember();
        });
        
        peer.on('error', (err) => {
            console.error('خطا در ایجاد عضو:', err);
            setTimeout(() => joinAsMember(), 2000);
        });
        
    } catch (error) {
        console.error('خطا در joinAsMember:', error);
        setTimeout(() => joinAsMember(), 2000);
    }
}

// ==================== تبدیل به ادمین پشتیبان ====================
async function becomeBackupAdmin() {
    if (amIAdmin) return;
    
    showNotification('👑 تبدیل به ادمین2...', 'warning');
    
    // اتصال فعلی را ببند
    if (peer) {
        peer.destroy();
    }
    
    // صبر کن ببین admin1 برمی‌گرده
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const admin1Exists = await testConnectionToAdmin('admin1');
    if (admin1Exists) {
        showNotification('✅ ادمین1 برگشته!', 'success');
        currentAdminName = 'admin1';
        wasConnectedToAdmin1 = true;
        joinAsMember();
        return;
    }
    
    // admin1 برنگشته، admin2 شو
    await becomeAdmin('admin2');
}

// ==================== سیستم مانیتورینگ مدیریت ====================
function startAdminMonitoring() {
    if (adminCheckInterval) clearInterval(adminCheckInterval);
    
    adminCheckInterval = setInterval(async () => {
        if (amIAdmin) {
            // اگر ما مدیر هستیم و admin1 نیستیم، چک کن admin1 برگشته یا نه
            if (currentAdminName === 'admin2') {
                const admin1Exists = await testConnectionToAdmin('admin1');
                if (admin1Exists) {
                    showNotification('👑 ادمین1 برگشته است!', 'info');
                    handleAdmin1Returned();
                }
            }
        } else if (currentAdminId) {
            // اگر عضو هستیم، چک کن مدیر آنلاین است یا نه
            const adminConnected = connections.has(currentAdminId) && 
                                 connections.get(currentAdminId).open;
            
            if (!adminConnected) {
                console.log('مدیریت قطع شده است');
                
                if (wasConnectedToAdmin1 && currentAdminName === 'admin1') {
                    // اگر به admin1 وصل بودیم و قطع شد، صبر کن شاید برگرده
                    showNotification('👑 ادمین1 قطع شد، در حال بررسی...', 'warning');
                    
                    setTimeout(async () => {
                        const admin1StillExists = await testConnectionToAdmin('admin1');
                        if (admin1StillExists) {
                            showNotification('✅ ادمین1 برگشته!', 'success');
                            connectToAdmin();
                        } else {
                            // admin1 برنگشته، به admin2 وصل شو
                            const admin2Exists = await testConnectionToAdmin('admin2');
                            if (admin2Exists) {
                                showNotification('🔗 در حال اتصال به ادمین2...', 'info');
                                currentAdminName = 'admin2';
                                connectToAdmin();
                            } else {
                                // admin2 هم نیست، خودت admin2 شو
                                showNotification('👑 تبدیل به ادمین2...', 'warning');
                                becomeBackupAdmin();
                            }
                        }
                    }, 5000);
                } else if (currentAdminName === 'admin2') {
                    // اگر به admin2 وصل بودیم و قطع شد
                    showNotification('👑 ادمین2 قطع شد!', 'error');
                    
                    setTimeout(async () => {
                        const admin1Exists = await testConnectionToAdmin('admin1');
                        if (admin1Exists) {
                            showNotification('✅ ادمین1 پیدا شد!', 'success');
                            currentAdminName = 'admin1';
                            wasConnectedToAdmin1 = true;
                            connectToAdmin();
                        } else {
                            showNotification('👑 تبدیل به ادمین1...', 'warning');
                            becomeBackupAdmin();
                        }
                    }, 3000);
                }
            }
        }
    }, 10000); // هر 10 ثانیه
}

function handleAdmin1Returned() {
    if (!amIAdmin || currentAdminName !== 'admin2') return;
    
    // اطلاع به همه کاربران
    broadcastToAll({
        type: 'admin1_returned',
        timestamp: Date.now()
    });
    
    // بستن اتصالات
    connections.forEach(conn => conn.close());
    connections.clear();
    
    // تبدیل به عضو و اتصال به admin1
    amIAdmin = false;
    currentAdminName = 'admin1';
    wasConnectedToAdmin1 = true;
    
    if (peer) {
        peer.destroy();
    }
    
    joinAsMember();
    
    showNotification('✅ مدیریت به admin1 منتقل شد', 'success');
}

// ==================== راه‌اندازی نقش‌ها ====================
function setupAsAdmin() {
    console.log('👑 تنظیم به عنوان مدیریت');
    
    users.set(myPeerId, {
        peerId: myPeerId,
        visibleName: myVisibleName,
        isAdmin: true,
        isOnline: true,
        lastSeen: Date.now(),
        isMe: true
    });
    
    loadExpirationSetting();
    loadMessageHistory();
    
    showChatPage();
    listenForIncomingConnections();
    startHeartbeatSystem();
    startExpirationSystem();
    startAdminMonitoring();
    startAutoSync();
    
    showNotification(`شما ${currentAdminName} شدید!`, 'success');
    updateUI();
    
    const systemMessage = {
        type: 'system_message',
        content: currentAdminName === 'admin1' 
            ? `👑 ${myVisibleName} به عنوان مدیریت اصلی انتخاب شد`
            : `⚠️ شبکه در حالت پشتیبان - مدیریت: ${myVisibleName}`,
        timestamp: Date.now(),
        messageId: generateMessageId(),
        isSystem: true
    };
    
    addToHistory(systemMessage);
    broadcastToAll(systemMessage);
    displayMessage(systemMessage, false, 'public');
}

function setupAsMember() {
    console.log('👤 تنظیم به عنوان عضو');
    
    users.set(myPeerId, {
        peerId: myPeerId,
        visibleName: myVisibleName,
        isAdmin: false,
        isOnline: true,
        lastSeen: Date.now(),
        isMe: true
    });
    
    loadExpirationSetting();
    
    showChatPage();
    listenForIncomingConnections();
    connectToAdmin();
    startAdminMonitoring();
    startAutoSync();
    
    showNotification(`به ${currentAdminName} متصل شدید`, 'success');
    updateUI();
}

function showChatPage() {
    document.getElementById('loginPage').style.display = 'none';
    document.getElementById('chatContainer').style.display = 'flex';
    initEmojiPicker();
    updateStorageInfo();
    updateNetworkStatus();
    updateAdminStatusDisplay();
    adjustForMobile();
}

// ==================== سیستم سینک خودکار ====================
function startAutoSync() {
    if (autoSyncInterval) clearInterval(autoSyncInterval);
    
    autoSyncInterval = setInterval(() => {
        if (!amIAdmin) {
            const adminConn = connections.get(currentAdminId);
            if (adminConn && adminConn.open) {
                adminConn.send({
                    type: 'sync_request',
                    timestamp: Date.now()
                });
            }
        } else {
            broadcastToAll({
                type: 'auto_sync',
                users: Array.from(users.values()).filter(u => u.isOnline),
                timestamp: Date.now()
            });
        }
        
        updateUsersList();
        updateStorageInfo();
    }, 60000);
}

// ==================== مدیریت اتصالات ====================
function listenForIncomingConnections() {
    peer.on('connection', (conn) => {
        console.log('🔗 درخواست اتصال از:', conn.peer);
        
        const peerId = conn.peer;
        connections.set(peerId, conn);
        setupConnectionListeners(conn, peerId);
        
        if (amIAdmin) {
            conn.on('open', () => {
                conn.send({
                    type: 'admin_info',
                    adminId: myPeerId,
                    adminName: myVisibleName,
                    adminRole: currentAdminName,
                    isEmergency: currentAdminName !== 'admin1',
                    timestamp: Date.now()
                });
                
                conn.send({
                    type: 'request_registration',
                    timestamp: Date.now()
                });
            });
        }
    });
}

function connectToAdmin() {
    showNotification(`در حال اتصال به ${currentAdminName}...`, 'info');
    
    const adminPeerId = `${GLOBAL_ROOM}_${currentAdminName}`;
    const conn = peer.connect(adminPeerId, {
        reliable: true,
        metadata: {
            type: 'member_connection',
            visibleName: myVisibleName,
            peerId: myPeerId,
            isNewUser: true,
            expiration: messageExpirationMinutes
        }
    });
    
    conn.on('open', () => {
        console.log(`✅ به ${currentAdminName} متصل شدیم`);
        currentAdminId = adminPeerId;
        connections.set(currentAdminId, conn);
        setupConnectionListeners(conn, currentAdminId);
        
        conn.send({
            type: 'register',
            peerId: myPeerId,
            visibleName: myVisibleName,
            expiration: messageExpirationMinutes,
            timestamp: Date.now()
        });
        
        showNotification(`به ${currentAdminName} متصل شدید`, 'success');
        updateConnectionStatus(true);
        updateAdminStatusDisplay();
    });
    
    conn.on('error', (err) => {
        console.error(`خطا در اتصال به ${currentAdminName}:`, err);
        updateConnectionStatus(false);
    });
}

function setupConnectionListeners(conn, peerId) {
    conn.on('data', (data) => {
        handleIncomingData(data, peerId);
    });
    
    conn.on('close', () => {
        console.log('❌ اتصال بسته شد با:', peerId);
        connections.delete(peerId);
        
        if (peerId === currentAdminId && !amIAdmin) {
            showNotification(`اتصال با ${currentAdminName} قطع شد`, 'warning');
            updateConnectionStatus(false);
        }
        
        updateUsersList();
    });
    
    conn.on('error', (err) => {
        console.error('خطا در اتصال:', peerId, err);
        connections.delete(peerId);
        
        if (peerId === currentAdminId && !amIAdmin) {
            showNotification(`خطا در اتصال با ${currentAdminName}`, 'error');
            updateConnectionStatus(false);
        }
    });
}

// ==================== پردازش داده‌های ورودی ====================
function handleIncomingData(data, fromPeerId) {
    switch(data.type) {
        case 'request_registration':
            handleRegistrationRequest(data, fromPeerId);
            break;
        case 'register':
            handleUserRegistration(data, fromPeerId);
            break;
        case 'public_message':
            handlePublicMessage(data, fromPeerId);
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
    }
}

function handleRegistrationRequest(data, fromPeerId) {
    if (!amIAdmin) return;
    
    const conn = connections.get(fromPeerId);
    if (conn && conn.open) {
        conn.send({
            type: 'please_register',
            adminId: myPeerId,
            adminName: myVisibleName,
            timestamp: Date.now()
        });
    }
}

function handleUserRegistration(data, fromPeerId) {
    if (!amIAdmin) return;
    
    const userInfo = {
        peerId: data.peerId,
        visibleName: data.visibleName,
        isAdmin: false,
        isOnline: true,
        lastSeen: Date.now(),
        isMe: false
    };
    
    users.set(data.peerId, userInfo);
    
    const conn = connections.get(fromPeerId);
    if (conn && conn.open) {
        conn.send({
            type: 'user_list',
            users: Array.from(users.values()).filter(u => u.isOnline),
            timestamp: Date.now()
        });
        
        sendMessageHistoryToUser(data.peerId);
    }
    
    broadcastToAll({
        type: 'user_joined',
        user: userInfo,
        timestamp: Date.now()
    }, [fromPeerId]);
    
    showNotification(`کاربر جدید: ${data.visibleName}`, 'success');
    updateUsersList();
}

function handlePublicMessage(data, fromPeerId) {
    if (amIAdmin && data.senderId === myPeerId) return;
    
    if (!data.likes) data.likes = [];
    if (!data.dislikes) data.dislikes = [];
    
    addToHistory(data);
    
    if (amIAdmin) {
        const conn = connections.get(fromPeerId);
        if (conn && conn.open) {
            conn.send({
                type: 'message_status',
                messageId: data.messageId,
                status: 'delivered',
                timestamp: Date.now()
            });
        }
        
        broadcastToAll({
            ...data,
            status: 'delivered'
        }, [fromPeerId, myPeerId]);
        
        displayMessage(data, data.senderId === myPeerId, 'public');
    } else {
        displayMessage(data, data.senderId === myPeerId, 'public');
    }
}

function handleUserList(data, fromPeerId) {
    data.users.forEach(user => {
        if (user.peerId !== myPeerId && !users.has(user.peerId)) {
            users.set(user.peerId, user);
        }
    });
    
    updateUsersList();
}

function handleHeartbeat(data, fromPeerId) {
    const user = users.get(fromPeerId);
    if (user) {
        user.lastSeen = Date.now();
        user.isOnline = true;
        updateUsersList();
    }
}

function handleMessageStatus(data, fromPeerId) {
    updateMessageStatus(data.messageId, data.status);
}

function handleImageChunk(data, fromPeerId) {
    if (!incomingImages.has(data.messageId)) {
        incomingImages.set(data.messageId, {
            chunks: [],
            total: data.totalChunks,
            mimeType: data.mimeType,
            senderName: data.senderName,
            senderId: data.senderId
        });
    }
    
    const img = incomingImages.get(data.messageId);
    img.chunks[data.chunkIndex] = data.data;
    
    const receivedChunks = img.chunks.filter(Boolean).length;
    
    if (receivedChunks === img.total) {
        const base64 = img.chunks.join('');
        const imageData = {
            type: 'image',
            content: base64,
            senderId: img.senderId,
            senderName: img.senderName,
            timestamp: Date.now(),
            messageId: data.messageId,
            status: 'delivered',
            likes: [],
            dislikes: []
        };
        
        if (amIAdmin) {
            addToHistory(imageData);
        }
        
        displayMessage(imageData, imageData.senderId === myPeerId, 'public');
        incomingImages.delete(data.messageId);
        
        showNotification('تصویر دریافت شد', 'success');
    }
}

function handleMessageHistoryChunk(data, fromPeerId) {
    data.chunk.forEach(message => {
        if (!messageHistory.some(m => m.messageId === message.messageId)) {
            displayMessage(message, message.senderId === myPeerId, 'public');
        }
    });
}

function handleMessageReaction(data, fromPeerId) {
    const messageIndex = messageHistory.findIndex(msg => msg.messageId === data.messageId);
    if (messageIndex > -1) {
        messageHistory[messageIndex].likes = data.likes || [];
        messageHistory[messageIndex].dislikes = data.dislikes || [];
    }
    
    updateReactionUI(data.messageId, data.likes, data.dislikes);
    
    if (amIAdmin) {
        broadcastToAll(data, [fromPeerId]);
    }
}

function handleExpiredMessages(data, fromPeerId) {
    data.messageIds.forEach(messageId => {
        const messageEl = document.getElementById(`msg_${messageId}`);
        if (messageEl) {
            messageEl.remove();
        }
    });
}

function handleSystemMessage(data, fromPeerId) {
    displayMessage(data, false, 'public');
}

function handleAdminInfo(data, fromPeerId) {
    currentAdminId = data.adminId;
    currentAdminName = data.adminRole || data.adminName;
    isEmergencyMode = data.isEmergency || false;
    wasConnectedToAdmin1 = (currentAdminName === 'admin1');
    
    updateNetworkStatus();
    updateAdminStatusDisplay();
}

function handleRedirectToAdmin1(data, fromPeerId) {
    showNotification('👑 در حال اتصال به ادمین1...', 'info');
    
    if (connections.has(fromPeerId)) {
        connections.get(fromPeerId).close();
        connections.delete(fromPeerId);
    }
    
    currentAdminName = 'admin1';
    wasConnectedToAdmin1 = true;
    connectToAdmin();
}

function handleAdmin1ReturnedMsg(data, fromPeerId) {
    showNotification('👑 ادمین1 برگشته است', 'info');
    
    const systemMessage = {
        type: 'system_message',
        content: '👑 مدیریت اصلی (admin1) به شبکه برگشته است',
        timestamp: Date.now(),
        messageId: generateMessageId(),
        isSystem: true
    };
    
    displayMessage(systemMessage, false, 'public');
}

function handleSyncRequest(data, fromPeerId) {
    if (!amIAdmin) return;
    
    const conn = connections.get(fromPeerId);
    if (conn && conn.open) {
        conn.send({
            type: 'user_list',
            users: Array.from(users.values()).filter(u => u.isOnline),
            timestamp: Date.now()
        });
    }
}

function handleAutoSync(data, fromPeerId) {
    data.users.forEach(user => {
        if (user.peerId !== myPeerId && !users.has(user.peerId)) {
            users.set(user.peerId, user);
        }
    });
    
    updateUsersList();
}

// ==================== مدیریت شبکه ====================
function broadcastToAll(data, excludePeers = []) {
    connections.forEach((conn, peerId) => {
        if (conn.open && !excludePeers.includes(peerId)) {
            try {
                conn.send(data);
            } catch (error) {
                console.error('خطا در ارسال به:', peerId, error);
            }
        }
    });
}

function startHeartbeatSystem() {
    if (amIAdmin) {
        heartbeatInterval = setInterval(() => {
            broadcastToAll({
                type: 'heartbeat',
                adminId: myPeerId,
                adminName: myVisibleName,
                adminRole: currentAdminName,
                timestamp: Date.now()
            });
            
            checkOfflineUsers();
        }, 10000);
    }
}

function checkOfflineUsers() {
    const now = Date.now();
    users.forEach((user, peerId) => {
        if (peerId !== myPeerId && now - user.lastSeen > 30000) {
            user.isOnline = false;
            updateUsersList();
        }
    });
}

// ==================== ارسال پیام‌ها ====================
function sendMessage() {
    const input = document.getElementById('messageInput');
    const content = input.value.trim();
    
    if (!content) return;
    
    const messageData = {
        type: 'public_message',
        content: content,
        senderId: myPeerId,
        senderName: myVisibleName,
        timestamp: Date.now(),
        messageId: generateMessageId(),
        status: 'sending',
        replyTo: replyingTo ? {
            messageId: replyingTo.messageId,
            author: replyingTo.author,
            content: replyingTo.content
        } : null,
        likes: [],
        dislikes: []
    };
    
    displayMessage(messageData, true, 'public');
    
    if (amIAdmin) {
        addToHistory(messageData);
        broadcastToAll(messageData, [myPeerId]);
        updateMessageStatus(messageData.messageId, 'delivered');
    } else {
        const adminConn = connections.get(currentAdminId);
        if (adminConn && adminConn.open) {
            adminConn.send(messageData);
        } else {
            showNotification('اتصال به مدیریت قطع است', 'error');
            updateMessageStatus(messageData.messageId, 'failed');
        }
    }
    
    cancelReply();
    input.value = '';
    autoResize(input);
    
    if (isMobile) {
        input.blur();
    }
}

// ==================== سیستم ریپلای ====================
function replyToMessage(messageId, author, content) {
    replyingTo = {
        messageId,
        author,
        content: content.length > 50 ? content.substring(0, 50) + '...' : content
    };
    
    document.getElementById('replyPanel').style.display = 'flex';
    document.getElementById('replyAuthor').textContent = `در پاسخ به ${author}:`;
    document.getElementById('replyContent').textContent = content;
    
    document.getElementById('messageInput').focus();
}

function cancelReply() {
    replyingTo = null;
    document.getElementById('replyPanel').style.display = 'none';
}

// ==================== ارسال تصویر با کیفیت بالا ====================
async function handleImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // محدودیت حجم: 10MB برای تصاویر با کیفیت
    if (file.size > 10 * 1024 * 1024) {
        showNotification('حجم فایل باید کمتر از ۱۰ مگابایت باشد', 'error');
        return;
    }
    
    // بررسی نوع فایل
    if (!file.type.startsWith('image/')) {
        showNotification('لطفاً فقط تصویر انتخاب کنید', 'error');
        return;
    }
    
    const reader = new FileReader();
    
    reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
            // کاهش کیفیت برای تصاویر بزرگ
            let quality = 0.8;
            if (img.width > 4000 || img.height > 4000) {
                quality = 0.6; // کیفیت کمتر برای 4K/8K
            } else if (img.width > 2000 || img.height > 2000) {
                quality = 0.7;
            }
            
            // ایجاد کانوس برای تغییر اندازه
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;
            
            // محدود کردن اندازه برای 8K
            const MAX_SIZE = 4096;
            if (width > MAX_SIZE || height > MAX_SIZE) {
                if (width > height) {
                    height = (height * MAX_SIZE) / width;
                    width = MAX_SIZE;
                } else {
                    width = (width * MAX_SIZE) / height;
                    height = MAX_SIZE;
                }
            }
            
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            
            // تبدیل به WebP برای فشرده‌سازی بهتر
            const webpData = canvas.toDataURL('image/webp', quality);
            sendImage(webpData, 'image/webp', file.name);
        };
        
        img.onerror = function() {
            showNotification('خطا در پردازش تصویر', 'error');
        };
        
        img.src = e.target.result;
    };
    
    reader.onerror = function() {
        showNotification('خطا در خواندن فایل', 'error');
    };
    
    reader.readAsDataURL(file);
    event.target.value = '';
}

function sendImage(base64Data, mimeType, fileName) {
    const MAX_CHUNK_SIZE = 16000; // افزایش برای تصاویر با کیفیت
    const messageId = generateMessageId();
    const totalChunks = Math.ceil(base64Data.length / MAX_CHUNK_SIZE);
    
    if (totalChunks > 100) {
        showNotification('تصویر خیلی بزرگ است!', 'error');
        return;
    }
    
    showNotification(`📸 در حال ارسال ${fileName || 'تصویر'} (${totalChunks} قطعه)...`, 'info');
    
    const loadingMessage = {
        type: 'image',
        senderId: myPeerId,
        senderName: myVisibleName,
        timestamp: Date.now(),
        messageId: messageId,
        status: 'sending',
        content: '📸 در حال بارگذاری تصویر...',
        totalChunks: totalChunks,
        fileName: fileName,
        likes: [],
        dislikes: []
    };
    
    displayMessage(loadingMessage, true, 'public');
    
    // ارسال قطعات با تاخیر
    for (let i = 0; i < totalChunks; i++) {
        const chunk = base64Data.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE);
        const chunkData = {
            type: 'image_chunk',
            messageId: messageId,
            chunkIndex: i,
            totalChunks: totalChunks,
            data: chunk,
            mimeType: mimeType,
            senderId: myPeerId,
            senderName: myVisibleName,
            fileName: fileName,
            timestamp: Date.now()
        };
        
        setTimeout(() => sendImageChunk(chunkData), i * 50); // کاهش تاخیر
    }
}

function sendImageChunk(chunkData) {
    if (amIAdmin) {
        broadcastToAll(chunkData, [myPeerId]);
    } else {
        const adminConn = connections.get(currentAdminId);
        if (adminConn && adminConn.open) {
            adminConn.send(chunkData);
        }
    }
}

// ==================== UI Functions ====================
function updateUI() {
    document.getElementById('connectionStatus').textContent = 
        amIAdmin ? `👑 مدیریت (${currentAdminName})` : '👤 عضو شبکه';
    
    const onlineCount = Array.from(users.values()).filter(u => u.isOnline).length;
    document.getElementById('onlineCount').textContent = onlineCount;
    document.getElementById('mobileUserCount').textContent = onlineCount;
    
    updateUsersList();
    updateNetworkStatus();
    updateAdminStatusDisplay();
}

function updateAdminStatusDisplay() {
    const adminStatusDisplay = document.getElementById('adminStatusDisplay');
    if (!adminStatusDisplay) return;
    
    if (amIAdmin) {
        adminStatusDisplay.innerHTML = currentAdminName === 'admin1' 
            ? `<span style="color: #00ff88;">👑 مدیریت اصلی</span>`
            : `<div class="emergency-alert">⚠️ مدیریت پشتیبان (${currentAdminName})</div>`;
    } else {
        adminStatusDisplay.innerHTML = currentAdminName === 'admin1'
            ? `<span style="color: #00ff88;">مدیریت: ${currentAdminName}</span>`
            : `<div class="emergency-alert">⚠️ مدیریت پشتیبان (${currentAdminName})</div>`;
    }
}

function updateNetworkStatus() {
    const networkStatus = document.getElementById('networkStatus');
    const networkStatusText = document.getElementById('networkStatusText');
    const networkAdminInfo = document.getElementById('networkAdminInfo');
    
    if (networkStatus && networkStatusText && networkAdminInfo) {
        if (amIAdmin) {
            networkStatusText.textContent = 'شما مدیریت هستید';
            networkAdminInfo.textContent = currentAdminName;
        } else if (currentAdminId && connections.has(currentAdminId)) {
            networkStatusText.textContent = 'اتصال برقرار است';
            networkAdminInfo.textContent = `مدیریت: ${currentAdminName}`;
        } else {
            networkStatusText.textContent = 'در حال اتصال...';
            networkAdminInfo.textContent = '';
        }
        
        if (!isMobile) {
            networkStatus.classList.add('hidden');
        } else {
            networkStatus.classList.remove('hidden');
        }
    }
}

function updateConnectionStatus(connected) {
    const indicator = document.getElementById('statusIndicator');
    const mobileIndicator = document.getElementById('mobileStatusIndicator');
    const statusText = document.getElementById('connectionStatus');
    
    if (connected) {
        indicator.className = 'user-status status-online';
        if (mobileIndicator) mobileIndicator.className = 'user-status status-online';
        statusText.textContent = amIAdmin ? `👑 مدیریت` : '✅ متصل';
    } else {
        indicator.className = 'user-status status-offline';
        if (mobileIndicator) mobileIndicator.className = 'user-status status-offline';
        statusText.textContent = '🔴 قطع';
    }
}

function updateUsersList() {
    const container = document.getElementById('publicUsersList');
    if (!container) return;
    
    container.innerHTML = '';
    
    users.forEach((user, peerId) => {
        if (!user.isMe) {
            const userEl = document.createElement('div');
            userEl.className = 'user-item';
            userEl.dataset.peerId = peerId;
            
            const userColor = getUserColor(peerId);
            const userStatus = user.isOnline ? 'status-online' : 'status-offline';
            
            userEl.innerHTML = `
                <div style="width: 40px; height: 40px; border-radius: 50%; background: ${user.isAdmin ? 'linear-gradient(135deg, #ffaa00, #ff8800)' : '#2a2a2a'}; color: white; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 16px; border: 2px solid ${userColor}">
                    ${user.visibleName.charAt(0)}
                </div>
                <div style="flex: 1;">
                    <div style="font-size: 14px; font-weight: 500; color: #e0e0e0; margin-bottom: 2px; display: flex; align-items: center;">
                        <div class="user-status ${userStatus}" style="margin-left: 5px;"></div>
                        ${user.visibleName}
                        ${user.isAdmin ? `<span class="admin-badge">${currentAdminName}</span>` : ''}
                    </div>
                    <div style="font-size: 11px; color: #b0b0b0;">
                        ${user.isAdmin ? 'مدیر شبکه' : 'کاربر'}
                    </div>
                </div>
            `;
            
            container.appendChild(userEl);
        }
    });
    
    const me = users.get(myPeerId);
    if (me) {
        const userEl = document.createElement('div');
        userEl.className = 'user-item';
        userEl.style.background = 'rgba(138, 43, 226, 0.1)';
        userEl.dataset.peerId = myPeerId;
        
        const myColor = getUserColor(myPeerId);
        
        userEl.innerHTML = `
            <div style="width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, #8a2be2, #6a0dad); color: white; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 16px; border: 2px solid ${myColor}">
                ${me.visibleName.charAt(0)}
            </div>
            <div style="flex: 1;">
                <div style="font-size: 14px; font-weight: 500; color: #e0e0e0; margin-bottom: 2px; display: flex; align-items: center;">
                    <div class="user-status status-online" style="margin-left: 5px;"></div>
                    ${me.visibleName}
                    <span class="me-badge">شما</span>
                    ${me.isAdmin ? `<span class="admin-badge">${currentAdminName}</span>` : ''}
                </div>
                <div style="font-size: 11px; color: #b0b0b0;">
                    ${me.isAdmin ? 'مدیر شبکه' : 'کاربر'}
                </div>
            </div>
        `;
        
        container.insertBefore(userEl, container.firstChild);
    }
    
    if (users.size <= 1) {
        container.innerHTML = `
            <div style="text-align: center; padding: 20px 0; color: #b0b0b0;">
                <div style="font-size: 32px; margin-bottom: 10px; opacity: 0.5;">👤</div>
                <p>کاربر دیگری وجود ندارد</p>
            </div>
        `;
    }
}

function displayMessage(data, isOutgoing, chatType) {
    const container = document.getElementById('messagesContainer');
    const emptyState = document.getElementById('emptyState');
    
    if (emptyState) {
        emptyState.style.display = 'none';
    }
    
    const shouldScroll = container.scrollTop + container.clientHeight >= container.scrollHeight - 100;
    
    const messageEl = document.createElement('div');
    messageEl.id = `msg_${data.messageId}`;
    messageEl.className = 'message-container';
    messageEl.dataset.senderId = data.senderId;
    messageEl.dataset.timestamp = data.timestamp;
    
    if (data.isSystem) {
        messageEl.style.cssText = `
            max-width: 90%;
            padding: 10px 14px;
            border-radius: 12px;
            margin: 5px auto;
            animation: fadeIn 0.3s ease;
            word-break: break-word;
            background: rgba(138, 43, 226, 0.1);
            color: #8a2be2;
            border: 1px solid rgba(138, 43, 226, 0.3);
            text-align: center;
            font-size: 12px;
            font-weight: bold;
        `;
        
        messageEl.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; gap: 8px;">
                <span>${data.content}</span>
            </div>
        `;
        
        container.appendChild(messageEl);
        if (shouldScroll) {
            scrollToBottom();
        }
        return;
    }
    
    const userColor = getUserColor(data.senderId);
    
    const backgroundColor = isOutgoing ? 
        `linear-gradient(135deg, ${userColor}20, ${userColor}10)` : 
        'linear-gradient(135deg, #2a2a2a, #1a1a1a)';
    
    const borderColor = userColor;
    const textColor = isOutgoing ? userColor : '#e0e0e0';
    
    messageEl.style.cssText = `
        max-width: ${isMobile ? '85%' : '65%'};
        padding: ${isMobile ? '10px 14px' : '12px 16px'};
        border-radius: 18px;
        animation: fadeIn 0.3s ease;
        word-break: break-word;
        cursor: pointer;
        background: ${backgroundColor};
        color: ${textColor};
        border: 2px solid ${borderColor};
        ${isOutgoing ? 
            'align-self: flex-end; border-bottom-left-radius: 5px;' : 
            'align-self: flex-start; border-bottom-right-radius: 5px;'
        }
        margin-bottom: 10px;
    `;
    
    if (data.type !== 'image') {
        messageEl.onclick = () => replyToMessage(data.messageId, data.senderName, data.content);
    }
    
    let statusIcon = '';
    if (isOutgoing) {
        if (data.status === 'sending') statusIcon = '🕐';
        else if (data.status === 'delivered') statusIcon = '✓✓';
        else if (data.status === 'read') statusIcon = '👁️✓';
        else if (data.status === 'failed') statusIcon = '❌';
    }
    
    let contentHtml = '';
    if (data.type === 'image') {
        contentHtml = `
            <div style="position: relative;">
                <img src="${data.content}" 
                     class="high-quality-image" 
                     onclick="viewImageFullscreen(this)" 
                     style="max-width: 100%; border-radius: 8px;"
                     loading="lazy"
                     alt="${data.fileName || 'تصویر'}">
                ${data.fileName ? `<div style="font-size: 10px; color: #888; margin-top: 4px;">${data.fileName}</div>` : ''}
            </div>
        `;
    } else {
        contentHtml = `<div class="message-content">${data.content}</div>`;
    }
    
    let replySection = '';
    if (data.replyTo) {
        replySection = `
            <div class="reply-container">
                <div class="reply-author">در پاسخ به ${data.replyTo.author}</div>
                <div class="reply-content">${data.replyTo.content}</div>
            </div>
        `;
    }
    
    const likes = data.likes || [];
    const dislikes = data.dislikes || [];
    const likeCount = likes.length;
    const dislikeCount = dislikes.length;
    
    const reactionButtons = `
        <div class="reaction-buttons">
            <div class="reaction-btn like-btn ${likes.includes(myPeerId) ? 'liked' : ''}" 
                 onclick="addReaction('${data.messageId}', 'like'); event.stopPropagation();">
                👍 ${likeCount}
            </div>
            <div class="reaction-btn dislike-btn ${dislikes.includes(myPeerId) ? 'disliked' : ''}" 
                 onclick="addReaction('${data.messageId}', 'dislike'); event.stopPropagation();">
                👎 ${dislikeCount}
            </div>
        </div>
    `;
    
    messageEl.innerHTML = `
        ${replySection}
        <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
            <div style="font-size: 12px; font-weight: 500; color: ${userColor};">
                ${data.senderName}
            </div>
            <div style="font-size: 11px; opacity: 0.8;">
                ${formatTime(data.timestamp)}
                ${isOutgoing ? `<span class="message-status status-${data.status}">${statusIcon}</span>` : ''}
            </div>
        </div>
        ${contentHtml}
        ${reactionButtons}
        <div class="message-date">${formatDate(data.timestamp)}</div>
    `;
    
    container.appendChild(messageEl);
    
    // محدود کردن تعداد پیام‌های نمایش داده شده
    const allMessages = container.querySelectorAll('.message-container');
    if (allMessages.length > 100) {
        for (let i = 0; i < allMessages.length - 100; i++) {
            allMessages[i].remove();
        }
    }
    
    if (shouldScroll) {
        scrollToBottom();
    }
}

function scrollToBottom() {
    setTimeout(() => {
        const container = document.getElementById('messagesContainer');
        if (container) {
            container.scrollTop = container.scrollHeight + 100; // اضافه کردن فضای اضافه
        }
    }, 100);
}

function updateMessageStatus(messageId, status) {
    const messageEl = document.getElementById(`msg_${messageId}`);
    if (messageEl) {
        const statusSpan = messageEl.querySelector('.message-status');
        if (statusSpan) {
            let statusIcon = '';
            if (status === 'sending') statusIcon = '🕐';
            else if (status === 'delivered') statusIcon = '✓✓';
            else if (status === 'read') statusIcon = '👁️✓';
            else if (status === 'failed') statusIcon = '❌';
            
            statusSpan.textContent = statusIcon;
            statusSpan.className = `message-status status-${status}`;
        }
    }
}

function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, isMobile ? 80 : 150) + 'px';
}

function handleKeyPress(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

function viewImageFullscreen(imgElement) {
    const fullscreenDiv = document.createElement('div');
    fullscreenDiv.className = 'image-message fullscreen';
    fullscreenDiv.onclick = () => fullscreenDiv.remove();
    
    const imgClone = imgElement.cloneNode();
    imgClone.style.maxWidth = '90%';
    imgClone.style.maxHeight = '90%';
    
    fullscreenDiv.appendChild(imgClone);
    document.body.appendChild(fullscreenDiv);
}

// ==================== پاکسازی کش ====================
function clearLocalStorage() {
    if (confirm('⚠️ آیا می‌خواهید ذخیره‌سازی محلی پاک شود؟')) {
        try {
            localStorage.clear();
            messageHistory = [];
            
            const container = document.getElementById('messagesContainer');
            container.innerHTML = '';
            document.getElementById('emptyState').style.display = 'block';
            
            messageExpirationMinutes = 5;
            selectExpiration(5);
            
            showNotification('✅ ذخیره‌سازی پاک شد', 'success');
            updateStorageInfo();
        } catch (error) {
            showNotification('❌ خطا در پاکسازی', 'error');
        }
    }
}

function initEmojiPicker() {
    const emojis = ['😀', '😂', '😍', '😎', '😭', '😡', '👍', '👎', '❤️', '🔥', '🎉', '💯'];
    const picker = document.getElementById('emojiPicker');
    const container = picker.querySelector('div:nth-child(2)');
    
    emojis.forEach(emoji => {
        const span = document.createElement('span');
        span.textContent = emoji;
        span.style.cursor = 'pointer';
        span.style.fontSize = '28px';
        span.style.padding = '5px';
        span.onclick = () => {
            const input = document.getElementById('messageInput');
            input.value += emoji;
            input.focus();
            autoResize(input);
            toggleEmojiPicker();
        };
        container.appendChild(span);
    });
}

function toggleEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    if (picker.style.display === 'none' || picker.style.display === '') {
        picker.style.display = 'block';
    } else {
        picker.style.display = 'none';
    }
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('mobileOverlay');
    if (sidebar.classList.contains('active')) {
        sidebar.classList.remove('active');
        overlay.classList.remove('active');
    } else {
        sidebar.classList.add('active');
        overlay.classList.add('active');
    }
}

function refreshNetwork() {
    showNotification('🔄 بروزرسانی شبکه...', 'info');
    
    if (!amIAdmin) {
        if (connections.has(currentAdminId)) {
            connections.get(currentAdminId).close();
        }
        connectToAdmin();
    }
    
    updateUsersList();
    
    if (isMobile) {
        toggleSidebar();
    }
}

function clearChat() {
    if (confirm('آیا می‌خواهید تاریخچه نمایشی پاک شود؟')) {
        const container = document.getElementById('messagesContainer');
        container.innerHTML = '';
        document.getElementById('emptyState').style.display = 'block';
        showNotification('تاریخچه نمایشی پاک شد', 'success');
    }
}

function leaveChat() {
    if (confirm('آیا می‌خواهید از چت خارج شوید؟')) {
        connections.forEach(conn => conn.close());
        connections.clear();
        
        clearInterval(heartbeatInterval);
        clearInterval(reconnectInterval);
        clearInterval(expirationInterval);
        clearInterval(adminCheckInterval);
        clearInterval(autoSyncInterval);
        
        document.getElementById('loginPage').style.display = 'flex';
        document.getElementById('chatContainer').style.display = 'none';
        
        showNotification('از چت خارج شدید', 'info');
    }
}

// ==================== تنظیمات موبایل ====================
function checkMobile() {
    isMobile = window.innerWidth <= 768;
    if (isMobile) {
        document.body.style.padding = "0";
        adjustForMobile();
    } else {
        document.body.style.padding = "20px";
    }
}

function adjustForMobile() {
    const messagesContainer = document.getElementById('messagesContainer');
    if (messagesContainer && isMobile) {
        messagesContainer.style.paddingBottom = "120px";
    }
}

// ==================== راه‌اندازی اولیه ====================
document.addEventListener('DOMContentLoaded', function() {
    loadExpirationSetting();
    checkMobile();
    
    const usernameInput = document.getElementById('usernameInput');
    if (usernameInput) {
        usernameInput.focus();
        
        // لاگین خودکار با Enter
        usernameInput.addEventListener('keypress', function(event) {
            if (event.key === 'Enter') {
                login();
            }
        });
    }
    
    // بستن ایموجی پیکر با کلیک بیرون
    document.addEventListener('click', function(event) {
        const emojiPicker = document.getElementById('emojiPicker');
        if (emojiPicker.style.display === 'block' && 
            !emojiPicker.contains(event.target)) {
            emojiPicker.style.display = 'none';
        }
    });
    
    window.addEventListener('resize', checkMobile);
    window.addEventListener('orientationchange', function() {
        setTimeout(checkMobile, 100);
    });
    
    // تنظیم فوکوس روی اینپوت در موبایل
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
        messageInput.addEventListener('focus', function() {
            if (isMobile) {
                setTimeout(() => {
                    scrollToBottom();
                }, 300);
            }
        });
    }
});
