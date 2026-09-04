interface ImageLightboxProps {
  src: string
  onClose: () => void
}

export default function ImageLightbox({ src, onClose }: ImageLightboxProps) {
  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <img src={src} alt="" onClick={e => e.stopPropagation()} />
    </div>
  )
}
