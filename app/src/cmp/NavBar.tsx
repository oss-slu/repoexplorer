interface NavBarProps {
    items: string[];
    active: string;
    onChange: (item: string) => void;
    type?: 'pills' | 'tabs';
}

export default function NavBar({
    items,
    active,
    onChange,
    type = 'pills',
}: NavBarProps) {
    return (
        <div className={`nav-bar ${type}`}>
            {items.map((item) => (
                <button
                    key={item}
                    type="button"
                    className={`nav-item ${item === active ? 'active' : ''}`}
                    onClick={() => onChange(item)}
                >
                    {item}
                </button>
            ))}
        </div>
    );
}
