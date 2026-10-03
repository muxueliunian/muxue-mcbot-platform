// 读取 JPEG 的宽高（SOF 段），只用于测试断言
export default function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a jpeg');
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('bad marker');
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('no SOF');
}
