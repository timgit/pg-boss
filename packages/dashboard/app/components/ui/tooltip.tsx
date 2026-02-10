import * as React from 'react'
import { cn } from '~/lib/utils'

interface TooltipProps {
  content: string
  children: React.ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
}

export function Tooltip({ content, children, side = 'right', align = 'center' }: TooltipProps) {
  const [isVisible, setIsVisible] = React.useState(false)
  const [position, setPosition] = React.useState({ top: 0, left: 0 })
  const triggerRef = React.useRef<HTMLElement>(null)
  const tooltipRef = React.useRef<HTMLDivElement>(null)

  const updatePosition = React.useCallback(() => {
    if (!triggerRef.current || !tooltipRef.current) return

    const triggerRect = triggerRef.current.getBoundingClientRect()
    const tooltipRect = tooltipRef.current.getBoundingClientRect()

    let top = 0
    let left = 0

    // Calculate position based on side
    switch (side) {
      case 'top':
        top = triggerRect.top - tooltipRect.height - 8
        left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2
        break
      case 'right':
        top = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2
        left = triggerRect.right + 8
        break
      case 'bottom':
        top = triggerRect.bottom + 8
        left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2
        break
      case 'left':
        top = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2
        left = triggerRect.left - tooltipRect.width - 8
        break
    }

    // Adjust for alignment
    if (side === 'top' || side === 'bottom') {
      if (align === 'start') {
        left = triggerRect.left
      } else if (align === 'end') {
        left = triggerRect.right - tooltipRect.width
      }
    } else {
      if (align === 'start') {
        top = triggerRect.top
      } else if (align === 'end') {
        top = triggerRect.bottom - tooltipRect.height
      }
    }

    setPosition({ top, left })
  }, [side, align])

  React.useEffect(() => {
    if (isVisible) {
      updatePosition()
      window.addEventListener('scroll', updatePosition, true)
      window.addEventListener('resize', updatePosition)
      return () => {
        window.removeEventListener('scroll', updatePosition, true)
        window.removeEventListener('resize', updatePosition)
      }
    }
  }, [isVisible, updatePosition])

  const handleMouseEnter = () => {
    setIsVisible(true)
  }

  const handleMouseLeave = () => {
    setIsVisible(false)
  }

  const child = React.Children.only(children) as React.ReactElement<any>
  const triggerElement = React.cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      if (node) {
        triggerRef.current = node
      }
      // Handle existing ref
      const existingRef = (child as any).ref
      if (typeof existingRef === 'function') {
        existingRef(node)
      } else if (existingRef) {
        existingRef.current = node
      }
    },
    onMouseEnter: (e: React.MouseEvent) => {
      handleMouseEnter()
      child.props?.onMouseEnter?.(e)
    },
    onMouseLeave: (e: React.MouseEvent) => {
      handleMouseLeave()
      child.props?.onMouseLeave?.(e)
    },
  })

  return (
    <>
      {triggerElement}
      {isVisible && (
        <div
          ref={tooltipRef}
          role="tooltip"
          style={{
            position: 'fixed',
            top: position.top,
            left: position.left,
            zIndex: 9999,
          }}
          className={cn(
            'px-3 py-1.5 text-sm font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-md shadow-lg',
            'pointer-events-none animate-in fade-in-0 zoom-in-95',
            'whitespace-nowrap'
          )}
        >
          {content}
        </div>
      )}
    </>
  )
}
