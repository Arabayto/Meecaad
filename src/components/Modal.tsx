import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

const activeModalStack: string[] = [];
const stackListeners = new Set<() => void>();

function notifyStackListeners() {
  stackListeners.forEach((listener) => listener());
}

function useModalStack(isOpen: boolean, onClose: () => void, zIndex?: number) {
  const modalIdRef = useRef<string>('');
  if (!modalIdRef.current) {
    modalIdRef.current = `dialog-${Math.random().toString(36).slice(2, 9)}`;
  }
  const modalId = modalIdRef.current;

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [, setRerender] = useState(0);

  // Subscribe to changes in activeModalStack across all instances
  useEffect(() => {
    const handleStackChange = () => setRerender((v) => v + 1);
    stackListeners.add(handleStackChange);
    return () => {
      stackListeners.delete(handleStackChange);
    };
  }, []);

  // Synchronously update stack so initial render immediately has the correct z-index
  if (isOpen && !activeModalStack.includes(modalId)) {
    activeModalStack.push(modalId);
  } else if (!isOpen && activeModalStack.includes(modalId)) {
    const idx = activeModalStack.indexOf(modalId);
    if (idx !== -1) {
      activeModalStack.splice(idx, 1);
    }
  }

  useEffect(() => {
    if (isOpen) {
      if (!activeModalStack.includes(modalId)) {
        activeModalStack.push(modalId);
        notifyStackListeners();
      }
      document.body.style.overflow = 'hidden';

      // Static backdrop: keyboard Escape does not accidentally close modals with unsaved data
      // Modals only close when explicitly clicking Close, Cancel, or the X button.
      const handleKeyDown = () => {};

      document.addEventListener('keydown', handleKeyDown);

      return () => {
        document.removeEventListener('keydown', handleKeyDown);
        const idx = activeModalStack.indexOf(modalId);
        if (idx !== -1) {
          activeModalStack.splice(idx, 1);
          notifyStackListeners();
        }
        if (activeModalStack.length === 0) {
          document.body.style.overflow = '';
        }
      };
    } else {
      const idx = activeModalStack.indexOf(modalId);
      if (idx !== -1) {
        activeModalStack.splice(idx, 1);
        notifyStackListeners();
      }
      if (activeModalStack.length === 0) {
        document.body.style.overflow = '';
      }
    }
  }, [isOpen, modalId]);

  const stackIndex = activeModalStack.indexOf(modalId);
  const level = stackIndex !== -1 ? stackIndex + 1 : Math.max(1, activeModalStack.length);
  const computedZ = 1000 + level * 100;
  const effectiveZIndex = zIndex !== undefined ? Math.max(zIndex, computedZ) : computedZ;

  return { effectiveZIndex };
}

interface ModalProps {
  isOpen?: boolean;
  open?: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl' | number | string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | number | string;
  id?: string;
  zIndex?: number;
}

export function Modal(props: ModalProps) {
  const {
    isOpen,
    open,
    onClose,
    title,
    children,
    footer,
    width = 'md',
    size,
    id = 'modal',
    zIndex,
  } = props;
  const isModalOpen = Boolean(isOpen ?? open);
  const { effectiveZIndex } = useModalStack(isModalOpen, onClose, zIndex);
  const panelWidth = size || width;
  const widthStyles: Record<string, string> = {
    sm: '420px',
    md: '520px',
    lg: '760px',
    xl: '960px',
  };

  let targetMaxWidth = '520px';
  if (typeof panelWidth === 'number') {
    targetMaxWidth = `${panelWidth}px`;
  } else if (typeof panelWidth === 'string' && widthStyles[panelWidth]) {
    targetMaxWidth = widthStyles[panelWidth];
  } else if (typeof panelWidth === 'string' && (panelWidth.endsWith('px') || panelWidth.endsWith('%'))) {
    targetMaxWidth = panelWidth;
  }

  if (!isModalOpen) return null;

  return (
    <div
      className="modal-backdrop"
      id={`${id}-backdrop`}
      style={{ zIndex: effectiveZIndex }}
    >
      <div
        className={`modal-panel modal-panel--${panelWidth}`}
        style={{ maxWidth: `min(calc(100vw - 32px), ${targetMaxWidth})`, width: '100%' }}
        onClick={(e) => e.stopPropagation()}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-panel__header">
          <h2>{title}</h2>
          <button
            type="button"
            className="modal-panel__close"
            onClick={onClose}
            aria-label="Close"
            id={`${id}-close`}
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-panel__body">{children}</div>
        {footer && <div className="modal-panel__footer">{footer}</div>}
      </div>
    </div>
  );
}

// Slide-over variant
interface SlideOverProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  id?: string;
  zIndex?: number;
}

export function SlideOver({
  isOpen,
  onClose,
  title,
  children,
  footer,
  id = 'slide-over',
  zIndex,
}: SlideOverProps) {
  const { effectiveZIndex } = useModalStack(isOpen, onClose, zIndex);

  if (!isOpen) return null;

  return (
    <div
      className="slide-over-backdrop"
      id={`${id}-backdrop`}
      style={{ zIndex: effectiveZIndex }}
    >
      <div
        className="slide-over-panel"
        onClick={(e) => e.stopPropagation()}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="slide-over-panel__header">
          <h2>{title}</h2>
          <button
            type="button"
            className="slide-over-panel__close"
            onClick={onClose}
            aria-label="Close"
            id={`${id}-close`}
          >
            <X size={18} />
          </button>
        </div>
        <div className="slide-over-panel__body">{children}</div>
        {footer && <div className="slide-over-panel__footer">{footer}</div>}
      </div>
    </div>
  );
}
