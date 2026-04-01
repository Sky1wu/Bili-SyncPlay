const steps = [
  {
    id: "popup-bootstrap",
    target: "popup",
    description:
      "启动扩展 popup，确认 server URL、连接状态、日志面板和房间表单已渲染。",
  },
  {
    id: "background-connect",
    target: "background",
    description:
      "通过 popup 触发连接，确认 background 收到 popup 消息并广播最新状态。",
  },
  {
    id: "content-bridge",
    target: "content",
    description:
      "在 Bilibili 页面注入 content script，确认可以上报用户信息并返回房间状态查询结果。",
  },
  {
    id: "share-current-video",
    target: "popup/background/content",
    description:
      "从 popup 发起分享当前视频，确认 background 读取活动标签页视频信息并转发到 content script。",
  },
  {
    id: "room-state-sync",
    target: "background/content",
    description:
      "模拟服务端房间状态广播，确认 content script 接收并应用共享视频与播放状态。",
  },
];

const output = {
  tool: "playwright",
  scope: "minimum-e2e-smoke",
  prerequisites: [
    "预先构建 extension 包并准备可加载的 unpacked extension 目录。",
    "准备可访问的测试服务端地址，以及至少一个可控的 Bilibili 页面环境。",
    "优先覆盖 popup、background、content script 三段消息链路，不扩展到管理员 UI。",
  ],
  steps,
};

console.log(JSON.stringify(output, null, 2));
