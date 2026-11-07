import styled, { css } from 'styled-components';

/**
 * Visual building blocks of the UUID management page. Colours come only from
 * the Strapi Design System theme, so light and dark mode both work, and
 * motion is limited to users without a reduced-motion preference.
 */

const motion = (rules) => css`
  @media (prefers-reduced-motion: no-preference) {
    ${rules}
  }
`;

/**
 * Hero banner. success600 to success700 with neutral0 text measures about
 * 5.0:1 to 6.7:1 in the light theme; the dark theme inverts both tokens
 * (light green with dark text), which keeps the contrast above 4.5:1.
 */
export const HeroBanner = styled.section`
  /* Solid fallback first: contrast tools and forced-colour modes read it. */
  background-color: ${({ theme }) => theme.colors.success600};
  background-image: linear-gradient(
    135deg,
    ${({ theme }) => theme.colors.success600} 0%,
    ${({ theme }) => theme.colors.success700} 100%
  );
  color: ${({ theme }) => theme.colors.neutral0};
  border-radius: ${({ theme }) => theme.borderRadius};
  padding: ${({ theme }) => theme.spaces[5]};
  min-width: 0;

  ${({ theme }) => theme.breakpoints.medium} {
    padding: ${({ theme }) => theme.spaces[7]};
  }
`;

export const HeroText = styled.p`
  margin: 0;
  color: inherit;
  font-size: ${({ theme, $size }) => theme.fontSizes[$size ?? 2]};
  font-weight: ${({ theme, $bold }) => ($bold ? theme.fontWeights.bold : theme.fontWeights.regular)};
  line-height: ${({ theme }) => theme.lineHeights[3]};
  overflow-wrap: anywhere;
`;

export const HeroBadge = styled.span`
  display: inline-flex;
  align-items: center;
  padding: ${({ theme }) => `${theme.spaces[1]} ${theme.spaces[3]}`};
  border: 1px solid currentColor;
  border-radius: ${({ theme }) => theme.borderRadius};
  font-size: ${({ theme }) => theme.fontSizes[1]};
  font-weight: ${({ theme }) => theme.fontWeights.bold};
  white-space: nowrap;
`;

export const Card = styled.div`
  background: ${({ theme }) => theme.colors.neutral0};
  border: 1px solid ${({ theme }) => theme.colors.neutral200};
  border-radius: ${({ theme }) => theme.borderRadius};
  padding: ${({ theme }) => theme.spaces[5]};
  height: 100%;
  min-width: 0;
  box-shadow: ${({ theme }) => theme.shadows.tableShadow};
`;

/** Action card: a real button, so it is keyboard- and screen-reader-operable. */
export const ActionCardButton = styled.button`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: ${({ theme }) => theme.spaces[3]};
  width: 100%;
  height: 100%;
  min-width: 0;
  padding: ${({ theme }) => theme.spaces[5]};
  background: ${({ theme }) => theme.colors.neutral0};
  border: 1px solid ${({ theme }) => theme.colors.neutral200};
  border-radius: ${({ theme }) => theme.borderRadius};
  box-shadow: ${({ theme }) => theme.shadows.tableShadow};
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;

  ${motion(css`
    transition:
      box-shadow 0.2s ease,
      border-color 0.2s ease,
      transform 0.2s ease;
  `)}

  &:hover:not(:disabled) {
    border-color: ${({ theme, $tone }) => theme.colors[`${$tone}600`]};
    box-shadow: ${({ theme }) => theme.shadows.popupShadow};
    ${motion(css`
      transform: translateY(-2px);
    `)}
  }

  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.primary600};
    outline-offset: 2px;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
`;

export const ActionIcon = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 4.8rem;
  height: 4.8rem;
  border-radius: ${({ theme }) => theme.borderRadius};
  background: ${({ theme, $tone }) => theme.colors[`${$tone}100`]};
  color: ${({ theme, $tone }) => theme.colors[`${$tone}700`]};

  svg {
    width: 2.4rem;
    height: 2.4rem;
    fill: currentColor;
  }
`;

export const ModelRow = styled.li`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.spaces[3]};
  padding: ${({ theme }) => theme.spaces[4]};
  border: 1px solid ${({ theme }) => theme.colors.neutral200};
  border-radius: ${({ theme }) => theme.borderRadius};
  background: ${({ theme }) => theme.colors.neutral0};
  min-width: 0;
`;

export const ModelList = styled.ul`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.spaces[3]};
  margin: 0;
  padding: 0;
  list-style: none;
`;

export const Mono = styled.span`
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow-wrap: anywhere;
`;

export const VisuallyHiddenInput = styled.input`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
`;

export const Fieldset = styled.fieldset`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.spaces[2]};
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;

  legend {
    padding: 0;
    margin-bottom: ${({ theme }) => theme.spaces[2]};
  }
`;
