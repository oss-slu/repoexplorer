import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import NavBar from '../../cmp/NavBar';

describe('NavBar', () => {
    const items = ['About', 'Repositories', 'Organizations'];

    it('renders all navigation items', () => {
        render(
            <NavBar items={items} active="Repositories" onChange={vi.fn()} />,
        );

        items.forEach((item) => {
            expect(
                screen.getByRole('button', { name: item }),
            ).toBeInTheDocument();
        });
    });

    it('applies the active class to the selected item', () => {
        render(
            <NavBar items={items} active="Repositories" onChange={vi.fn()} />,
        );

        const activeButton = screen.getByRole('button', {
            name: 'Repositories',
        });
        const inactiveButton = screen.getByRole('button', { name: 'About' });

        expect(activeButton).toHaveClass('active');
        expect(inactiveButton).not.toHaveClass('active');
    });

    it('calls onChange with the clicked item', async () => {
        const handleChange = vi.fn();
        const user = userEvent.setup();

        render(
            <NavBar
                items={items}
                active="Repositories"
                onChange={handleChange}
            />,
        );

        await user.click(screen.getByRole('button', { name: 'Organizations' }));

        expect(handleChange).toHaveBeenCalledTimes(1);
        expect(handleChange).toHaveBeenCalledWith('Organizations');
    });

    it('renders with pills or tabs class depending on the type prop', () => {
        const { container: pillsContainer } = render(
            <NavBar
                items={items}
                active="Repositories"
                onChange={vi.fn()}
                type="pills"
            />,
        );
        expect(pillsContainer.firstChild).toHaveClass('pills');

        const { container: tabsContainer } = render(
            <NavBar
                items={items}
                active="Repositories"
                onChange={vi.fn()}
                type="tabs"
            />,
        );
        expect(tabsContainer.firstChild).toHaveClass('tabs');
    });
});
