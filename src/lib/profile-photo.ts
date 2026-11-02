export async function prepareProfilePhoto(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a JPEG, PNG, or WebP photo.')
  }
  if (file.size > 10 * 1024 * 1024) throw new Error('Choose a photo smaller than 10 MB.')
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 60_000_000) {
      throw new Error('This photo is too large to process. Choose a smaller photo.')
    }
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 512
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser could not process the photo.')
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 512, 512)
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 512, 512)
    // Re-encoding bounds storage size and removes the original photo metadata.
    const result = canvas.toDataURL('image/jpeg', 0.82)
    if (result.length >= 500_000) throw new Error('This photo could not be reduced enough. Choose a smaller photo.')
    return result
  } catch (error) {
    throw error instanceof Error && error.name !== 'EncodingError' ? error : new Error('This photo could not be read. Choose another photo.')
  } finally { URL.revokeObjectURL(url) }
}
