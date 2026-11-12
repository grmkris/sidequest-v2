// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";
import {ERC3009PaymentCollector} from "commerce-payments/src/collectors/ERC3009PaymentCollector.sol";

import {DeploySidequestOperator} from "../script/DeploySidequestOperator.s.sol";
import {SidequestOperator} from "../src/SidequestOperator.sol";

contract DeploySidequestOperatorTest is Test {
    DeploySidequestOperator internal script;

    function setUp() public {
        script = new DeploySidequestOperator();
    }

    function test_refusesMainnets() public {
        uint256[5] memory mainnets = [uint256(1), 8453, 10, 42_161, 143];
        for (uint256 i; i < mainnets.length; ++i) {
            vm.chainId(mainnets[i]);
            vm.expectRevert(abi.encodeWithSelector(DeploySidequestOperator.ChainNotAllowed.selector, mainnets[i]));
            script.run();
        }
    }

    function test_allowsTestnets() public view {
        script.requireTestnet(5_042_002);
        script.requireTestnet(84_532);
        script.requireTestnet(31_337);
    }

    /// @dev One test, because environment variables are process-wide and tests run in parallel.
    function test_deploysLocallyFromEnv() public {
        vm.chainId(31_337);
        vm.setEnv("SIDEQUEST_FEE_RECEIVER", vm.toString(makeAddr("treasury")));
        vm.setEnv("AUTH_CAPTURE_ESCROW", vm.toString(makeAddr("nothing here")));
        vm.expectRevert(abi.encodeWithSelector(DeploySidequestOperator.MissingCode.selector, makeAddr("nothing here")));
        script.run();

        AuthCaptureEscrow escrow = new AuthCaptureEscrow();
        ERC3009PaymentCollector collector = new ERC3009PaymentCollector(address(escrow), address(1));
        vm.setEnv("AUTH_CAPTURE_ESCROW", vm.toString(address(escrow)));
        vm.setEnv("ERC3009_PAYMENT_COLLECTOR", vm.toString(address(collector)));
        vm.setEnv("SIDEQUEST_FEE_RECEIVER", vm.toString(makeAddr("treasury")));
        vm.setEnv("SIDEQUEST_FEE_BPS", "65536");
        vm.expectRevert(abi.encodeWithSelector(DeploySidequestOperator.FeeOutOfRange.selector, 65_536));
        script.run();

        vm.setEnv("SIDEQUEST_FEE_BPS", "500");
        SidequestOperator op = script.run();
        assertEq(address(op.ESCROW()), address(escrow));
        assertEq(op.COLLECTOR(), address(collector));
        assertEq(op.FEE_BPS(), 500);
        assertEq(op.FEE_RECEIVER(), makeAddr("treasury"));
    }
}
