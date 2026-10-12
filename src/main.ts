import './ui/styles.css';
import { createApp } from './app';

const root = document.getElementById('app');
if (root) {
  try {
    createApp(root);
  } catch (error) {
    console.error('[蜘蛛纸牌] 启动失败', error);
  }
} else {
  console.error('[蜘蛛纸牌] 未找到 #app 挂载点');
}
