import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
// 图标按需引入：@element-plus/icons-vue 内置上千个图标，
// 全量注册会让 renderer 体积增加数百 KB，这里只注册本项目实际用到的。
import {
  Bell,
  Camera,
  ChatRound,
  Close,
  Connection,
  FullScreen,
  InfoFilled,
  Link,
  Minus,
  Monitor,
  Paperclip,
  Picture,
  PictureFilled,
  Plus,
  Promotion,
  Remove,
  Refresh,
  Right,
  Setting,
  SwitchButton,
  User,
  VideoCamera,
  VideoPause
} from '@element-plus/icons-vue'
import App from './App.vue'
import ScreenShot from './components/ScreenShot.vue'
import BroadcastWindow from './components/BroadcastWindow.vue'
// 基础样式放最后导入，便于覆盖 Element Plus 的主题变量
import './style.css'

// 同一个 index.html 承载两种窗口：
// · 主窗口：完整的联系人 / 聊天 / 广播控制界面
// · 学生端屏幕广播观看窗口：由主进程带 ?broadcast=1 打开，只渲染画面
const isBroadcastWindow =
  new URLSearchParams(location.search).get('broadcast') === '1'
const isShotWindow =
  new URLSearchParams(location.search).get('screenshot') === '1'

if (isShotWindow) {
  // 框选截屏层：只跑一个轻量组件，不初始化 pinia / 不注册发现监听
  const shotApp = createApp(ScreenShot)
  shotApp.use(ElementPlus, { locale: zhCn, size: 'small' })
  shotApp.mount('#app')
} else if (isBroadcastWindow) {
  const bwApp = createApp(BroadcastWindow)
  bwApp.use(ElementPlus, { locale: zhCn, size: 'small' })
  bwApp.mount('#app')
} else {
  const app = createApp(App)

  // 全局注册图标后，模板中可直接写 <el-icon><Setting /></el-icon>
  const icons = {
    Bell,
    Camera,
    ChatRound,
    Close,
    Connection,
    FullScreen,
  InfoFilled,
  Link,
  Minus,
  Monitor,
    Paperclip,
    Picture,
    PictureFilled,
    Plus,
    Promotion,
    Remove,
    Refresh,
    Right,
    Setting,
    SwitchButton,
    User,
    VideoCamera,
    VideoPause
  }
  for (const [name, component] of Object.entries(icons)) {
    app.component(name, component)
  }

  app.use(createPinia())
  // size 统一为 small，贴合本项目偏紧凑的界面密度
  app.use(ElementPlus, { locale: zhCn, size: 'small' })
  app.mount('#app')
}
