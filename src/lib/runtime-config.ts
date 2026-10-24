// 版本同时锁定 package.json；不在运行时下载或安装用户声明的依赖。
export const REACT_RUNTIME_VERSION = "19.3.1";
export const REACT_RUNTIME_BUILD_VERSION = 1;
export const REACT_RUNTIME_DEPENDENCIES = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
] as const;
