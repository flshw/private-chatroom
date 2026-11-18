/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · random Chinese nickname pool (short-drama / comic-drama
 * style). Compiled from popular web-novel & 微短剧 character names (柳如烟、
 * 沈知意、叶凡…), the 小X/如X family, and soft 2-3 character net names.
 * UMD: window.PCNicknames in browsers, module.exports in Node (unit tests).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PCNicknames = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ~100 popular short-drama / comic-drama style names, all 2-3 Chinese chars. */
  var NAMES = [
    /* 小X 家族（萌系） */
    '小帅', '小美', '小可爱', '小仙女', '小妖精', '小机灵', '小奶龙', '小甜心',
    '小橘子', '小栗子', '小葡萄', '小汤圆', '小布丁', '小糯米', '小丸子', '小鱼干',
    /* 如X / 柳X 家族（网文经典） */
    '如烟', '如意', '如梦', '如初', '柳如烟', '柳如意', '柳如眉', '柳如梦',
    /* 温柔小白花女主 */
    '沈知意', '林晚晴', '苏清颜', '温知夏', '苏晚', '苏念希', '温软', '阮软',
    '夏晚星', '白若溪', '林知柔', '温初夏', '苏星晚', '江凌玥', '叶凝霜',
    /* 大女主 / 飒爽逆袭 */
    '楚清辞', '顾清鸢', '沈惊鸿', '唐凝月', '云灵汐', '洛九鸢', '慕晚晴', '秦晚卿',
    /* 霸总 / 男主 */
    '叶凡', '秦无道', '顾霆琛', '厉景深', '陆景川', '季铭修', '傅景深', '顾夜宸',
    '薄司寒', '战北寒', '凌御爵', '墨霆枭', '沈知衍', '陆执渊', '封夜寒',
    /* 清冷斯文男主 */
    '谢砚辞', '宋聿修', '裴砚辞', '周霆深', '秦墨渊', '封时序', '苏砚辰', '温景然',
    /* 古风 / 仙侠 */
    '子墨', '倾城', '浅陌', '若曦', '沐辰', '夜殇', '墨渊', '白夜',
    '青鸾', '扶苏', '长歌', '南风', '北辰', '知雪', '无涯', '知遥',
    /* 可爱 2 字 */
    '团子', '糖果', '喵喵', '朵朵', '莉莉', '安安', '琪琪', '萌萌',
    /* 情绪氛围类 */
    '心动', '遇见', '偏爱', '温柔', '清欢', '旧梦', '初见', '余生'
  ];

  /* Guard: keep only valid 2-3 character Chinese strings. */
  var VALID = NAMES.filter(function (s) {
    return /^[\u4e00-\u9fa5]{2,3}$/.test(s);
  });

  function random() {
    if (!VALID.length) return 'Anonymous';
    return VALID[Math.floor(Math.random() * VALID.length)];
  }

  /* Pick n distinct names (used for the 3 local bots). */
  function pick(n) {
    var pool = VALID.slice(), out = [];
    while (n-- > 0 && pool.length) {
      out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return out;
  }

  return { list: VALID, names: VALID, random: random, pick: pick };
});
