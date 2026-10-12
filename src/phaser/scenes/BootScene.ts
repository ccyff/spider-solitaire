import Phaser from 'phaser';
import { bus } from '../../core/bus';
import { ATLAS, buildCardTextures, buildFxTextures } from '../cardArt';

/**
 * 启动场景：只做一件事——把牌面图集下下来，切成 52 张牌 + 牌背，然后进牌桌。
 * 加载进度会通过事件总线发给 DOM 加载条（手机上先把进度显示出来再进游戏）。
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    this.load.image(ATLAS.key, ATLAS.url);
    this.load.on(Phaser.Loader.Events.PROGRESS, (value: number) => {
      bus.emit('load:progress', { value });
    });
    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      bus.emit('load:progress', { value: 1 });
    });
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      bus.emit('load:error', { url: file?.src ?? ATLAS.url });
    });
  }

  create(): void {
    const texture = this.textures.get(ATLAS.key);
    const source = texture?.getSourceImage() as CanvasImageSource | undefined;
    if (!source) {
      bus.emit('load:error', { url: ATLAS.url });
      return;
    }
    buildCardTextures(this, source);
    buildFxTextures(this);
    // 图集已经切成单张纹理，本体不再需要，先释放掉
    this.textures.remove(ATLAS.key);
    bus.emit('load:done', undefined);
    this.scene.start('Game');
  }
}
