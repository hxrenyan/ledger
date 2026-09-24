-- 图片识别模型切换为 SiliconFlow DeepSeek-OCR。
-- 只替换旧默认模型，保留已有地址、密钥、启用状态和接力顺序；可重复执行。
UPDATE ai_profiles
SET model = 'deepseek-ai/DeepSeek-OCR'
WHERE kind = 'ocr'
  AND model = 'PaddlePaddle/PaddleOCR-VL-1.5';
