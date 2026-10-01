/**
 * JSON 文件导入导出工具。
 *
 * 资源纪律：
 *  - 导出创建的每个 Object URL 都登记在本模块的集合中，revoke 后立即移除；
 *  - revokeAllOnWindow() 供页面卸载兜底；
 *  - 读文件使用 FileReader 文本通道，本身不创建对象 URL；
 *  - 文件大小在读取前就按硬上限拒绝，避免大文件挤占内存。
 */

export const MAX_IMPORT_BYTES = 8 * 1024 * 1024; // 8 MB

const liveUrls = new Set<string>();

/** 触发浏览器下载，并在下载调度后尽快回收 Object URL */
export function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  liveUrls.add(url);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 现代浏览器在 click 后已拿到数据；setTimeout 兜底后回收，保证不残留
  setTimeout(() => revokeObjectUrl(url), 0);
}

export function revokeObjectUrl(url: string): void {
  if (liveUrls.has(url)) {
    URL.revokeObjectURL(url);
    liveUrls.delete(url);
  }
}

/** 测试/卸载用：回收所有尚未释放的 Object URL，清空残留定时器的可能影响 */
export function revokeAllObjectUrls(): number {
  const count = liveUrls.size;
  liveUrls.forEach((url) => URL.revokeObjectURL(url));
  liveUrls.clear();
  return count;
}

/** 读取用户选择的 .json 文件；空文件/超限/读取失败都抛出可展示的错误 */
export function readJsonFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size === 0) {
      reject(new Error('文件为空'));
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      reject(new Error(`文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 8 MB`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('读取失败：结果不是文本'));
    };
    reader.onerror = () => reject(new Error(`文件读取失败${reader.error ? `：${reader.error}` : ''}`));
    reader.readAsText(file);
  });
}
