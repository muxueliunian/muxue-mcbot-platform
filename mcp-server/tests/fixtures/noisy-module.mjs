// 模拟第三方库在被 import 时（入口正文执行之前）就往 stdout 打日志
console.log('{"jsonrpc":"2.0","id":0,"result":"startup noise"}');
console.log(`${new Date().toISOString()} startup timestamp noise`);
