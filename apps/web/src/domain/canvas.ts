/**
 * 这里只保留网页端第一阶段需要的领域常量，避免把 React/Electron 依赖带进页面层。
 */
export const CANVAS_NODE_TYPES = {
  upload: 'uploadNode', imageEdit: 'imageNode', aiVideo: 'aiVideoNode', aiText: 'aiTextNode',
  aiAudio: 'aiAudioNode', exportImage: 'exportImageNode', video: 'videoNode', audio: 'audioNode',
  textAnnotation: 'textAnnotationNode', jsonCard: 'jsonCardNode', group: 'groupNode', tag: 'tagNode',
  tagGroup: 'tagGroupNode', storyboardSplit: 'storyboardNode', storyboardGen: 'storyboardGenNode',
  panorama: 'panoramaNode', blueprint: 'blueprintNode',
} as const;
export type CanvasNodeType = typeof CANVAS_NODE_TYPES[keyof typeof CANVAS_NODE_TYPES];
export const IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'] as const;
export const CANVAS_NODE_LABELS: Record<CanvasNodeType, string> = {
  uploadNode: '上传素材', imageNode: '图像生成', aiVideoNode: '视频生成', aiTextNode: '文本生成', aiAudioNode: '音频生成',
  exportImageNode: '导出图像', videoNode: '视频素材', audioNode: '音频素材', textAnnotationNode: '文本标注', jsonCardNode: '结构化卡片',
  groupNode: '节点分组', tagNode: '标签', tagGroupNode: '标签组', storyboardNode: '分镜切分', storyboardGenNode: '分镜生成', panoramaNode: '全景图', blueprintNode: '导演台',
};

export function isCanvasGenerationNode(type: CanvasNodeType) { return type === CANVAS_NODE_TYPES.imageEdit || type === CANVAS_NODE_TYPES.aiVideo || type === CANVAS_NODE_TYPES.storyboardGen || type === CANVAS_NODE_TYPES.aiText || type === CANVAS_NODE_TYPES.aiAudio; }

/** 当前真实生成 API 已接通的节点；文本、音频与分镜节点仍作为配置节点，不进入付费执行队列。 */
export function isRunnableCanvasGenerationNode(type: CanvasNodeType) {
  return type === CANVAS_NODE_TYPES.imageEdit || type === CANVAS_NODE_TYPES.aiVideo;
}
